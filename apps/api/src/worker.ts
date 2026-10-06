import 'dotenv/config';
import { pool } from './db.js';
import { transaction } from './domain.js';
import { assignDriver } from './assignment.js';
import { liveEvent, storeNotifications, type OutboxEvent } from './event-handling.js';
import { connectedRedis, redis } from './redis.js';

type Job = { id: string; kind: string; payload: { deliveryId: string; version: number }; attempts: number };

async function processOneJob() {
  const claimed = await pool.query<Job>(
    `UPDATE jobs SET status = 'PROCESSING', claimed_at = NOW(), attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE (status = 'PENDING' AND run_at <= NOW())
          OR (status = 'PROCESSING' AND claimed_at < NOW() - INTERVAL '60 seconds')
       ORDER BY run_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
     ) RETURNING id, kind, payload, attempts`,
  );
  const job = claimed.rows[0];
  if (!job) return false;
  try {
    if (job.kind !== 'ASSIGN_DRIVER') throw new Error(`Unknown job kind: ${job.kind}`);
    await assignDriver(job.payload.deliveryId, job.payload.version);
    await pool.query("UPDATE jobs SET status = 'DONE', claimed_at = NULL WHERE id = $1", [job.id]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dead = job.attempts >= 5 || message.startsWith('Unknown job kind:');
    const delaySeconds = Math.min(2 ** job.attempts * 3, 60);
    await pool.query(
      `UPDATE jobs SET status = $2, run_at = NOW() + ($3 * INTERVAL '1 second'),
       claimed_at = NULL, last_error = $4 WHERE id = $1`,
      [job.id, dead ? 'DEAD' : 'PENDING', delaySeconds, message],
    );
    console.error(`Job ${job.id}: ${message}`);
  }
  return true;
}

async function processOneEvent() {
  return transaction(async (client) => {
    const result = await client.query<OutboxEvent>(
      'SELECT id, aggregate_id, event_type, payload FROM outbox_events WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1',
    );
    const item = result.rows[0];
    if (!item) return false;
    await storeNotifications(client, item);
    const redis = await connectedRedis();
    await redis.publish('fleetflow:events', JSON.stringify(liveEvent(item)));
    await client.query('UPDATE outbox_events SET published_at = NOW(), attempts = attempts + 1 WHERE id = $1', [item.id]);
    return true;
  });
}

let running = true;
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

async function main() {
  console.log('FleetFlow worker started');
  while (running) {
    try {
      const didJob = await processOneJob();
      const didEvent = await processOneEvent();
      if (!didJob && !didEvent) await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error('Worker loop:', error);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  if (redis.isOpen) await redis.quit();
  await pool.end();
}

void main();
