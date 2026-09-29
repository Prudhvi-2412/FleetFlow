import { pool } from './db.js';
import { connectedRedis } from './redis.js';

export function validCoordinates(lat: unknown, lng: unknown): lat is number {
  return typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90
    && typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

export async function updateLocation(driverId: string, lat: number, lng: number) {
  const redis = await connectedRedis();
  const online = await redis.get(`driver:online:${driverId}`);
  if (!online) return { accepted: false as const, reason: 'Driver must be online' };

  const timestamp = new Date().toISOString();
  await redis.set(`driver:location:${driverId}`, JSON.stringify({ lat, lng, timestamp }), { EX: 60 });
  await redis.expire(`driver:online:${driverId}`, 120);

  const sample = await redis.set(`driver:sample:${driverId}`, '1', { NX: true, EX: 10 });
  if (sample) {
    try {
      await pool.query(
        'UPDATE drivers SET last_lat = $2, last_lng = $3, last_seen_at = NOW() WHERE user_id = $1 AND is_online = TRUE',
        [driverId, lat, lng],
      );
    } catch (error) {
      await redis.del(`driver:sample:${driverId}`);
      throw error;
    }
  }

  const broadcast = await redis.set(`driver:broadcast:${driverId}`, '1', { NX: true, EX: 1 });
  if (broadcast) {
    await redis.publish('fleetflow:events', JSON.stringify({ type: 'location.update', driverId, lat, lng, timestamp }));
  }
  return { accepted: true as const, timestamp };
}
