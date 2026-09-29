import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db.js';

export type DeliveryStatus =
  | 'ASSIGNMENT_PENDING' | 'DRIVER_ASSIGNED' | 'ACCEPTED' | 'PICKED_UP'
  | 'OUT_FOR_DELIVERY' | 'ARRIVED' | 'DELIVERED' | 'FAILED' | 'CANCELLED';

export type Delivery = {
  id: string;
  customer_id: string;
  driver_id: string | null;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  status: DeliveryStatus;
  failure_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function event(
  client: PoolClient,
  deliveryId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    'INSERT INTO outbox_events (aggregate_id, event_type, payload) VALUES ($1, $2, $3)',
    [deliveryId, eventType, JSON.stringify(payload)],
  );
}

export async function enqueueAssignment(client: PoolClient, deliveryId: string, version: number): Promise<void> {
  await client.query(
    `INSERT INTO jobs (id, kind, payload, dedupe_key)
     VALUES ($1, 'ASSIGN_DRIVER', $2, $3) ON CONFLICT (dedupe_key) DO NOTHING`,
    [randomUUID(), JSON.stringify({ deliveryId, version }), `assign:${deliveryId}:${version}`],
  );
}

export async function changeStatus(
  client: PoolClient,
  delivery: Delivery,
  next: DeliveryStatus,
  actorId: string | null,
  eventType: string,
): Promise<Delivery> {
  const result = await client.query<Delivery>(
    `UPDATE deliveries SET status = $2, version = version + 1, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [delivery.id, next],
  );
  await client.query(
    `INSERT INTO delivery_status_history (delivery_id, from_status, to_status, actor_id)
     VALUES ($1, $2, $3, $4)`,
    [delivery.id, delivery.status, next, actorId],
  );
  await event(client, delivery.id, eventType, {
    deliveryId: delivery.id,
    customerId: delivery.customer_id,
    driverId: delivery.driver_id,
    from: delivery.status,
    to: next,
    actorId,
  });
  return result.rows[0]!;
}
