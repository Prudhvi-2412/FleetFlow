import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from './auth.js';
import { pool } from './db.js';
import { updateLocation } from './locations.js';
import { connectedRedis } from './redis.js';

export const driversRouter = Router();
driversRouter.use(requireAuth, requireRole('driver'));

driversRouter.get('/me', async (request, response) => {
  const result = await pool.query(
    'SELECT user_id, is_online, last_seen_at, last_lat, last_lng FROM drivers WHERE user_id = $1',
    [request.user!.id],
  );
  return response.json({ driver: result.rows[0] });
});

driversRouter.post('/me/online', async (request, response) => {
  await pool.query('UPDATE drivers SET is_online = TRUE WHERE user_id = $1', [request.user!.id]);
  const redis = await connectedRedis();
  await redis.set(`driver:online:${request.user!.id}`, '1', { EX: 120 });
  return response.json({ isOnline: true });
});

driversRouter.post('/me/offline', async (request, response) => {
  const busy = await pool.query(
    `SELECT 1 FROM driver_assignments WHERE driver_id = $1 AND status IN ('OFFERED', 'ACCEPTED')`,
    [request.user!.id],
  );
  if (busy.rowCount) return response.status(409).json({ error: 'Finish or reject the active assignment first' });
  await pool.query('UPDATE drivers SET is_online = FALSE WHERE user_id = $1', [request.user!.id]);
  const redis = await connectedRedis();
  await redis.del(`driver:online:${request.user!.id}`);
  return response.json({ isOnline: false });
});

driversRouter.put('/me/location', async (request, response) => {
  const parsed = z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Invalid coordinates' });
  const result = await updateLocation(request.user!.id, parsed.data.lat, parsed.data.lng);
  if (!result.accepted) return response.status(409).json({ error: result.reason });
  return response.json(result);
});

driversRouter.get('/me/assignments', async (request, response) => {
  const result = await pool.query(
    `SELECT a.id, a.status AS assignment_status, a.created_at AS assigned_at,
            d.* FROM driver_assignments a JOIN deliveries d ON d.id = a.delivery_id
     WHERE a.driver_id = $1 ORDER BY a.created_at DESC LIMIT 100`,
    [request.user!.id],
  );
  return response.json({ assignments: result.rows });
});
