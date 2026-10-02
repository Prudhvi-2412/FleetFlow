import { randomUUID } from 'node:crypto';
import { changeStatus, transaction, type Delivery } from './domain.js';

export class RetryableAssignmentError extends Error {}

function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(bLat - aLat);
  const dLng = radians(bLng - aLng);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export async function assignDriver(deliveryId: string, version: number) {
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
      await changeStatus(client, { ...delivery, driver_id: candidate.user_id }, 'DRIVER_ASSIGNED', null, 'DriverAssigned');
      return;
    }
    throw new RetryableAssignmentError('No available driver within 25 km');
  });
}
