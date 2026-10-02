import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from './auth.js';
import { pool } from './db.js';
import { changeStatus, transaction, type Delivery } from './domain.js';
import { hashPassword } from './password.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('admin'));

const createDriverInput = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
  vehicleLabel: z.string().trim().min(1).max(100).optional(),
  plateNumber: z.string().trim().min(2).max(30).optional(),
});

adminRouter.post('/drivers', async (request, response) => {
  const parsed = createDriverInput.safeParse(request.body);
  if (!parsed.success || (!!parsed.data?.vehicleLabel !== !!parsed.data?.plateNumber)) {
    return response.status(400).json({ error: 'Invalid driver details' });
  }
  const data = parsed.data;
  const id = randomUUID();
  const passwordHash = await hashPassword(data.password);
  try {
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, email, full_name, password_hash, role)
         VALUES ($1, $2, $3, $4, 'driver')`,
        [id, data.email, data.fullName, passwordHash],
      );
      await client.query('INSERT INTO drivers (user_id) VALUES ($1)', [id]);
      if (data.vehicleLabel && data.plateNumber) {
        await client.query(
          'INSERT INTO vehicles (id, driver_id, label, plate_number) VALUES ($1, $2, $3, $4)',
          [randomUUID(), id, data.vehicleLabel, data.plateNumber],
        );
      }
    });
    return response.status(201).json({ driver: { id, email: data.email, fullName: data.fullName } });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return response.status(409).json({ error: 'Email or plate number already exists' });
    }
    throw error;
  }
});

adminRouter.get('/drivers', async (_request, response) => {
  const result = await pool.query(
    `SELECT u.id, u.full_name, u.email, d.is_online, d.last_seen_at, d.last_lat, d.last_lng,
            v.label AS vehicle_label, v.plate_number,
            a.delivery_id AS active_delivery_id
     FROM drivers d JOIN users u ON u.id = d.user_id
     LEFT JOIN vehicles v ON v.driver_id = d.user_id
     LEFT JOIN driver_assignments a ON a.driver_id = d.user_id AND a.status IN ('OFFERED', 'ACCEPTED')
     ORDER BY u.full_name`,
  );
  return response.json({ drivers: result.rows });
});

adminRouter.get('/metrics', async (_request, response) => {
  const [deliveries, drivers, jobs, notifications] = await Promise.all([
    pool.query("SELECT status, COUNT(*)::int AS count FROM deliveries GROUP BY status"),
    pool.query("SELECT COUNT(*) FILTER (WHERE is_online AND last_seen_at > NOW() - INTERVAL '2 minutes')::int AS online, COUNT(*)::int AS total FROM drivers"),
    pool.query("SELECT status, COUNT(*)::int AS count FROM jobs GROUP BY status"),
    pool.query('SELECT COUNT(*)::int AS total FROM notifications'),
  ]);
  return response.json({ deliveryStatuses: deliveries.rows, drivers: drivers.rows[0], jobStatuses: jobs.rows, notifications: notifications.rows[0] });
});

adminRouter.get('/jobs/dead', async (_request, response) => {
  const result = await pool.query(
    "SELECT id, kind, payload, attempts, last_error, created_at FROM jobs WHERE status = 'DEAD' ORDER BY created_at DESC LIMIT 100",
  );
  return response.json({ jobs: result.rows });
});

adminRouter.post('/jobs/:id/retry', async (request, response) => {
  const id = z.uuid().safeParse(request.params.id);
  if (!id.success) return response.status(400).json({ error: 'Invalid job ID' });
  const result = await pool.query(
    `UPDATE jobs SET status = 'PENDING', attempts = 0, run_at = NOW(), claimed_at = NULL,
       dispatched_at = NULL, last_error = NULL
     WHERE id = $1 AND status = 'DEAD' RETURNING id`,
    [id.data],
  );
  if (!result.rowCount) return response.status(404).json({ error: 'Dead job not found' });
  return response.json({ retried: true });
});

adminRouter.post('/deliveries/:id/assign', async (request, response) => {
  const deliveryId = z.uuid().safeParse(request.params.id);
  const driverId = z.uuid().safeParse(request.body?.driverId);
  if (!deliveryId.success || !driverId.success) return response.status(400).json({ error: 'Invalid assignment request' });

  const result = await transaction(async (client) => {
    const locked = await client.query<Delivery>('SELECT * FROM deliveries WHERE id = $1 FOR UPDATE', [deliveryId.data]);
    const delivery = locked.rows[0];
    if (!delivery) return { status: 404, body: { error: 'Delivery not found' } };
    if (['DELIVERED', 'FAILED', 'CANCELLED'].includes(delivery.status)) {
      return { status: 409, body: { error: 'Delivery is already closed' } };
    }
    if (delivery.driver_id === driverId.data) return { status: 200, body: delivery };

    const driver = await client.query(
      `SELECT user_id FROM drivers WHERE user_id = $1 AND is_online = TRUE
       AND last_seen_at > NOW() - INTERVAL '2 minutes' FOR UPDATE SKIP LOCKED`,
      [driverId.data],
    );
    if (!driver.rowCount) return { status: 409, body: { error: 'Driver is unavailable' } };
    const busy = await client.query(
      `SELECT 1 FROM driver_assignments WHERE driver_id = $1 AND status IN ('OFFERED', 'ACCEPTED')`,
      [driverId.data],
    );
    if (busy.rowCount) return { status: 409, body: { error: 'Driver has an active assignment' } };

    await client.query(
      `UPDATE driver_assignments SET status = 'REASSIGNED', responded_at = NOW()
       WHERE delivery_id = $1 AND status IN ('OFFERED', 'ACCEPTED')`,
      [deliveryId.data],
    );
    await client.query(
      `INSERT INTO driver_assignments (id, delivery_id, driver_id, status)
       VALUES ($1, $2, $3, 'OFFERED')`,
      [randomUUID(), deliveryId.data, driverId.data],
    );
    await client.query('UPDATE deliveries SET driver_id = $2 WHERE id = $1', [deliveryId.data, driverId.data]);
    const updated = await changeStatus(client, { ...delivery, driver_id: driverId.data }, 'DRIVER_ASSIGNED', request.user!.id, 'DriverAssigned');
    return { status: 200, body: updated };
  });
  return response.status(result.status).json(result.body);
});

adminRouter.post('/deliveries/:id/fail', async (request, response) => {
  const id = z.uuid().safeParse(request.params.id);
  const reason = z.string().trim().min(3).max(500).safeParse(request.body?.reason);
  if (!id.success || !reason.success) return response.status(400).json({ error: 'Invalid failure report' });
  const result = await transaction(async (client) => {
    const locked = await client.query<Delivery>('SELECT * FROM deliveries WHERE id = $1 FOR UPDATE', [id.data]);
    const delivery = locked.rows[0];
    if (!delivery) return { status: 404, body: { error: 'Delivery not found' } };
    if (delivery.status === 'FAILED') return { status: 200, body: delivery };
    if (['DELIVERED', 'CANCELLED'].includes(delivery.status)) return { status: 409, body: { error: 'Delivery is already closed' } };
    await client.query('UPDATE deliveries SET failure_reason = $2 WHERE id = $1', [id.data, reason.data]);
    await client.query(
      `UPDATE driver_assignments SET status = 'FAILED', responded_at = NOW()
       WHERE delivery_id = $1 AND status IN ('OFFERED', 'ACCEPTED')`, [id.data],
    );
    const updated = await changeStatus(client, delivery, 'FAILED', request.user!.id, 'DeliveryFailed');
    return { status: 200, body: { ...updated, failure_reason: reason.data } };
  });
  return response.status(result.status).json(result.body);
});
