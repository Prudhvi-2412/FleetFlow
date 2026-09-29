import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { changeStatus, transaction, type Delivery } from './domain.js';
import { connectedRedis, redis } from './redis.js';

type Job = { id: string; kind: string; payload: { deliveryId: string; version: number }; attempts: number };
type OutboxEvent = {
  id: string; aggregate_id: string; event_type: string;
  payload: { customerId?: string; driverId?: string; deliveryId?: string; to?: string };
};

class RetryableError extends Error {}

function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(bLat - aLat);
  const dLng = radians(bLng - aLng);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

async function assignDriver(deliveryId: string, version: number) {
  return transaction(async (client) => {
    const result = await client.query<Delivery>('SELECT * FROM deliveries WHERE id = $1 FOR UPDATE', [deliveryId]);
    const delivery = result.rows[0];
    if (!delivery || delivery.status !== 'ASSIGNMENT_PENDING' || delivery.version !== version) return;

    const candidates = await client.query<{ user_id: string; last_lat: number; last_lng: number }>(
      `SELECT d.user_id, d.last_lat, d.last_lng FROM drivers d
       WHERE d.is_online = TRUE AND d.last_seen_at > NOW() - INTERVAL '2 minutes'
         AND d.last_lat IS NOT NULL AND d.last_lng IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM driver_assignments a WHERE a.driver_id = d.user_id AND a.status IN ('OFFERED', 'ACCEPTED'))
         AND NOT EXISTS (SELECT 1 FROM driver_assignments a WHERE a.driver_id = d.user_id AND a.delivery_id = $1 AND a.status = 'REJECTED')`,
      [deliveryId],
    );
    const ranked = candidates.rows
      .map((candidate) => ({ ...candidate, distance: distanceKm(delivery.pickup_lat, delivery.pickup_lng, candidate.last_lat, candidate.last_lng) }))
      .filter((candidate) => candidate.distance <= 25)
      .sort((a, b) => a.distance - b.distance);

    for (const candidate of ranked) {
      const lock = await client.query(
        'SELECT user_id FROM drivers WHERE user_id = $1 AND is_online = TRUE FOR UPDATE SKIP LOCKED',
        [candidate.user_id],
      );
      if (!lock.rowCount) continue;
      const busy = await client.query(
        `SELECT 1 FROM driver_assignments WHERE driver_id = $1 AND status IN ('OFFERED', 'ACCEPTED')`,
        [candidate.user_id],
      );
      if (busy.rowCount) continue;
      await client.query(
        `INSERT INTO driver_assignments (id, delivery_id, driver_id, status)
         VALUES ($1, $2, $3, 'OFFERED')`,
        [randomUUID(), deliveryId, candidate.user_id],
      );
      await client.query('UPDATE deliveries SET driver_id = $2 WHERE id = $1', [deliveryId, candidate.user_id]);
      await changeStatus(
        client,
        { ...delivery, driver_id: candidate.user_id },
        'DRIVER_ASSIGNED',
        null,
        'DriverAssigned',
      );
      return;
    }
    throw new RetryableError('No available driver within 25 km');
  });
}

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

function notificationText(eventType: string) {
  const titles: Record<string, string> = {
    DeliveryCreated: 'Delivery created', DriverAssigned: 'Driver assigned',
    DeliveryAccepted: 'Driver accepted', DriverRejected: 'Driver declined',
    DeliveryPickedUp: 'Package picked up', DeliveryStarted: 'Out for delivery',
    DriverArrived: 'Driver arrived', DeliveryCompleted: 'Delivery completed',
    DeliveryFailed: 'Delivery failed', DeliveryCancelled: 'Delivery cancelled',
  };
  return titles[eventType] ?? eventType;
}

async function processOneEvent() {
  return transaction(async (client) => {
    const result = await client.query<OutboxEvent>(
      'SELECT id, aggregate_id, event_type, payload FROM outbox_events WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1',
    );
    const item = result.rows[0];
    if (!item) return false;
    const recipients = [...new Set([item.payload.customerId, item.payload.driverId].filter((value): value is string => !!value))];
    for (const userId of recipients) {
      await client.query(
        `INSERT INTO notifications (id, event_id, user_id, delivery_id, title, body)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id, user_id) DO NOTHING`,
        [randomUUID(), item.id, userId, item.aggregate_id, notificationText(item.event_type), `Delivery ${item.aggregate_id}`],
      );
    }
    const redis = await connectedRedis();
    await redis.publish('fleetflow:events', JSON.stringify({ type: 'delivery.event', eventType: item.event_type, ...item.payload }));
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
