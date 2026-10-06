import 'dotenv/config';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { assignDriver } from './assignment.js';
import { pool } from './db.js';
import { transaction } from './domain.js';
import { liveEvent, storeNotifications, type OutboxEvent } from './event-handling.js';
import { connectedRedis, redis } from './redis.js';
import { eventMessage } from './aws-event-message.js';

const assignmentQueue = process.env.ASSIGNMENT_QUEUE_URL;
const notificationQueue = process.env.NOTIFICATION_QUEUE_URL;
const eventBus = process.env.EVENT_BUS_NAME;
if (!assignmentQueue || !notificationQueue || !eventBus) {
  throw new Error('ASSIGNMENT_QUEUE_URL, NOTIFICATION_QUEUE_URL and EVENT_BUS_NAME are required');
}
const sqs = new SQSClient({});
const events = new EventBridgeClient({});
const abort = new AbortController();
let running = true;
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
function stop() { running = false; abort.abort(); }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const jobMessage = z.object({ jobId: z.uuid() });
async function dispatchOneJob() {
  return transaction(async (client) => {
    const found = await client.query<{ id: string }>(
      `SELECT id FROM jobs WHERE status = 'PENDING' AND run_at <= NOW() AND dispatched_at IS NULL
       ORDER BY run_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const job = found.rows[0];
    if (!job) return false;
    await sqs.send(new SendMessageCommand({ QueueUrl: assignmentQueue, MessageBody: JSON.stringify({ jobId: job.id }) }));
    await client.query('UPDATE jobs SET dispatched_at = NOW() WHERE id = $1', [job.id]);
    return true;
  });
}

async function dispatchOneEvent() {
  return transaction(async (client) => {
    const found = await client.query<OutboxEvent>(
      `SELECT id, aggregate_id, event_type, payload FROM outbox_events
       WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const item = found.rows[0];
    if (!item) return false;
    const result = await events.send(new PutEventsCommand({ Entries: [{
      EventBusName: eventBus,
      Source: 'fleetflow',
      DetailType: item.event_type,
      Detail: JSON.stringify({ eventId: String(item.id), aggregateId: item.aggregate_id, eventType: item.event_type, payload: item.payload }),
    }] }));
    if (result.FailedEntryCount || !result.Entries?.[0]?.EventId) {
      throw new Error(`EventBridge rejected event ${item.id}: ${JSON.stringify(result.Entries?.[0])}`);
    }
    await client.query('UPDATE outbox_events SET published_at = NOW(), attempts = attempts + 1 WHERE id = $1', [item.id]);
    return true;
  });
}

async function processAssignment(jobId: string) {
  const claimed = await pool.query<{ id: string; payload: { deliveryId: string; version: number }; attempts: number }>(
    `UPDATE jobs SET status = 'PROCESSING', claimed_at = NOW(), attempts = attempts + 1
     WHERE id = $1 AND kind = 'ASSIGN_DRIVER'
       AND ((status = 'PENDING' AND run_at <= NOW())
         OR (status = 'PROCESSING' AND claimed_at < NOW() - INTERVAL '60 seconds'))
     RETURNING id, payload, attempts`, [jobId],
  );
  const job = claimed.rows[0];
  if (!job) {
    const state = await pool.query<{ status: string; run_at: Date }>('SELECT status, run_at FROM jobs WHERE id = $1', [jobId]);
    if (!state.rows[0]) throw new Error(`Assignment job ${jobId} does not exist`);
    return state.rows[0].status !== 'PROCESSING';
  }
  try {
    await assignDriver(job.payload.deliveryId, job.payload.version);
    await pool.query("UPDATE jobs SET status = 'DONE', claimed_at = NULL WHERE id = $1", [jobId]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dead = job.attempts >= 5;
    const delaySeconds = Math.min(2 ** job.attempts * 3, 60);
    await pool.query(
      `UPDATE jobs SET status = $2, run_at = NOW() + ($3 * INTERVAL '1 second'),
       claimed_at = NULL, dispatched_at = NULL, last_error = $4 WHERE id = $1`,
      [jobId, dead ? 'DEAD' : 'PENDING', delaySeconds, message],
    );
    console.error(`Assignment job ${jobId}: ${message}`);
  }
  return true;
}

async function processNotification(item: OutboxEvent) {
  await transaction(async (client) => {
    await storeNotifications(client, item);
    const connection = await connectedRedis();
    await connection.publish('fleetflow:events', JSON.stringify(liveEvent(item)));
  });
}

async function consume(queueUrl: string, handler: (body: string) => Promise<boolean>) {
  while (running) {
    try {
      const received = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 10, VisibilityTimeout: 120,
      }), { abortSignal: abort.signal });
      for (const message of received.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) continue;
        try {
          if (await handler(message.Body)) {
            await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
          }
        } catch (error) { console.error(`SQS message ${message.MessageId}:`, error); }
      }
    } catch (error) {
      if (!running) break;
      console.error('SQS receive:', error);
      await delay(1_000);
    }
  }
}

async function publishLoop() {
  while (running) {
    try {
      const job = await dispatchOneJob();
      const event = await dispatchOneEvent();
      if (!job && !event) await delay(500);
    } catch (error) {
      console.error('AWS publisher:', error);
      await delay(1_000);
    }
  }
}

async function main() {
  console.log('FleetFlow AWS worker started');
  await Promise.all([
    publishLoop(),
    consume(assignmentQueue!, async (body) => processAssignment(jobMessage.parse(JSON.parse(body)).jobId)),
    consume(notificationQueue!, async (body) => {
      const detail = eventMessage.parse(JSON.parse(body)).detail;
      await processNotification({
        id: detail.eventId, aggregate_id: detail.aggregateId,
        event_type: detail.eventType, payload: detail.payload,
      });
      return true;
    }),
  ]);
  if (redis.isOpen) await redis.quit();
  await pool.end();
  sqs.destroy();
  events.destroy();
}

void main();
