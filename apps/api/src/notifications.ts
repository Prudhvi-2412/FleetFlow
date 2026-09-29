import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from './auth.js';
import { pool } from './db.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get('/', async (request, response) => {
  const result = await pool.query(
    'SELECT id, delivery_id, title, body, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
    [request.user!.id],
  );
  return response.json({ notifications: result.rows });
});

notificationsRouter.patch('/:id/read', async (request, response) => {
  const id = z.uuid().safeParse(request.params.id);
  if (!id.success) return response.status(400).json({ error: 'Invalid notification ID' });
  const result = await pool.query(
    'UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2 RETURNING id, read_at',
    [id.data, request.user!.id],
  );
  if (!result.rowCount) return response.status(404).json({ error: 'Notification not found' });
  return response.json({ notification: result.rows[0] });
});
