import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from './auth.js';
import { pool } from './db.js';
import { changeStatus, enqueueAssignment, event, transaction, type Delivery, type DeliveryStatus } from './domain.js';

const point = z.object({
  address: z.string().trim().min(3).max(300),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
const createInput = z.object({ pickup: point, dropoff: point });
const idParam = z.uuid();
const nextStatus = z.enum(['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED']);

export const deliveriesRouter = Router();
deliveriesRouter.use(requireAuth);

deliveriesRouter.post('/', requireRole('customer'), async (request, response) => {
  const parsed = createInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Invalid delivery details' });
  const key = request.header('Idempotency-Key');
  if (!key || key.length > 128) return response.status(400).json({ error: 'Idempotency-Key header is required' });
  const customerId = request.user!.id;
  const hash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');

  const result = await transaction(async (client) => {
    await client.query(
      `INSERT INTO idempotency_keys (user_id, scope, key, request_hash)
       VALUES ($1, 'delivery.create', $2, $3) ON CONFLICT DO NOTHING`,
      [customerId, key, hash],
    );
    const existing = await client.query<{
      request_hash: string; response_status: number | null; response_body: Delivery | null;
    }>(
      `SELECT request_hash, response_status, response_body FROM idempotency_keys
       WHERE user_id = $1 AND scope = 'delivery.create' AND key = $2 FOR UPDATE`,
      [customerId, key],
    );
    const record = existing.rows[0]!;
    if (record.request_hash !== hash) return { status: 409, body: { error: 'Idempotency key reused with different request' } };
    if (record.response_status && record.response_body) return { status: record.response_status, body: record.response_body };

    const id = randomUUID();
    const { pickup, dropoff } = parsed.data;
    const inserted = await client.query<Delivery>(
      `INSERT INTO deliveries (
        id, customer_id, pickup_address, pickup_lat, pickup_lng,
        dropoff_address, dropoff_lat, dropoff_lng, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ASSIGNMENT_PENDING') RETURNING *`,
      [id, customerId, pickup.address, pickup.lat, pickup.lng, dropoff.address, dropoff.lat, dropoff.lng],
    );
    const delivery = inserted.rows[0]!;
    await client.query(
      `INSERT INTO delivery_status_history (delivery_id, to_status, actor_id)
       VALUES ($1, 'ASSIGNMENT_PENDING', $2)`, [id, customerId],
    );
    await enqueueAssignment(client, id, delivery.version);
    await event(client, id, 'DeliveryCreated', { deliveryId: id, customerId });
    await client.query(
      `UPDATE idempotency_keys SET response_status = 201, response_body = $3
       WHERE user_id = $1 AND scope = 'delivery.create' AND key = $2`,
      [customerId, key, JSON.stringify(delivery)],
    );
    return { status: 201, body: delivery };
  });
  return response.status(result.status).json(result.body);
});

deliveriesRouter.get('/', async (request, response) => {
  const user = request.user!;
  const filter = user.role === 'customer' ? 'd.customer_id' : user.role === 'driver' ? 'd.driver_id' : null;
  const result = filter
    ? await pool.query<Delivery>(`SELECT d.*, u.full_name AS driver_name FROM deliveries d LEFT JOIN users u ON u.id = d.driver_id WHERE ${filter} = $1 ORDER BY d.created_at DESC LIMIT 100`, [user.id])
    : await pool.query<Delivery>('SELECT d.*, u.full_name AS driver_name FROM deliveries d LEFT JOIN users u ON u.id = d.driver_id ORDER BY d.created_at DESC LIMIT 100');
  return response.json({ deliveries: result.rows });
});

deliveriesRouter.get('/:id', async (request, response) => {
  const id = idParam.safeParse(request.params.id);
  if (!id.success) return response.status(400).json({ error: 'Invalid delivery ID' });
  const result = await pool.query<Delivery>(
    'SELECT d.*, u.full_name AS driver_name FROM deliveries d LEFT JOIN users u ON u.id = d.driver_id WHERE d.id = $1',
    [id.data],
  );
  const delivery = result.rows[0];
  if (!delivery) return response.status(404).json({ error: 'Delivery not found' });
  const user = request.user!;
  if (user.role !== 'admin' && delivery.customer_id !== user.id && delivery.driver_id !== user.id) {
    return response.status(403).json({ error: 'Forbidden' });
  }
  const history = await pool.query(
    'SELECT from_status, to_status, actor_id, created_at FROM delivery_status_history WHERE delivery_id = $1 ORDER BY id',
    [id.data],
  );
  return response.json({ delivery, history: history.rows });
});

async function driverTransition(
  deliveryId: string,
  driverId: string,
  action: 'accept' | 'reject' | DeliveryStatus,
) {
  return transaction(async (client) => {
    const locked = await client.query<Delivery>('SELECT * FROM deliveries WHERE id = $1 FOR UPDATE', [deliveryId]);
    const delivery = locked.rows[0];
    if (!delivery) return { status: 404, body: { error: 'Delivery not found' } };
    if (delivery.driver_id !== driverId) return { status: 403, body: { error: 'Not your delivery' } };

    if (action === 'accept') {
      if (delivery.status === 'ACCEPTED') return { status: 200, body: delivery };
      if (delivery.status !== 'DRIVER_ASSIGNED') return { status: 409, body: { error: 'Delivery cannot be accepted now' } };
      await client.query(
        `UPDATE driver_assignments SET status = 'ACCEPTED', responded_at = NOW()
         WHERE delivery_id = $1 AND driver_id = $2 AND status = 'OFFERED'`,
        [deliveryId, driverId],
      );
      return { status: 200, body: await changeStatus(client, delivery, 'ACCEPTED', driverId, 'DeliveryAccepted') };
    }

    if (action === 'reject') {
      if (delivery.status !== 'DRIVER_ASSIGNED') return { status: 409, body: { error: 'Delivery cannot be rejected now' } };
      await client.query(
        `UPDATE driver_assignments SET status = 'REJECTED', responded_at = NOW()
         WHERE delivery_id = $1 AND driver_id = $2 AND status = 'OFFERED'`,
        [deliveryId, driverId],
      );
      const pending = await changeStatus(client, delivery, 'ASSIGNMENT_PENDING', driverId, 'DriverRejected');
      await client.query('UPDATE deliveries SET driver_id = NULL WHERE id = $1', [deliveryId]);
      await enqueueAssignment(client, deliveryId, pending.version);
      return { status: 200, body: { ...pending, driver_id: null } };
    }

    if (delivery.status === action) return { status: 200, body: delivery };
    const allowed: Partial<Record<DeliveryStatus, DeliveryStatus>> = {
      ACCEPTED: 'PICKED_UP',
      PICKED_UP: 'OUT_FOR_DELIVERY',
      OUT_FOR_DELIVERY: 'ARRIVED',
      ARRIVED: 'DELIVERED',
    };
    if (allowed[delivery.status] !== action) return { status: 409, body: { error: 'Invalid status transition' } };
    const eventName: Record<string, string> = {
      PICKED_UP: 'DeliveryPickedUp', OUT_FOR_DELIVERY: 'DeliveryStarted',
      ARRIVED: 'DriverArrived', DELIVERED: 'DeliveryCompleted',
    };
    const updated = await changeStatus(client, delivery, action, driverId, eventName[action]!);
    if (action === 'DELIVERED') {
      await client.query(
        `UPDATE driver_assignments SET status = 'COMPLETED', responded_at = NOW()
         WHERE delivery_id = $1 AND driver_id = $2 AND status = 'ACCEPTED'`,
        [deliveryId, driverId],
      );
    }
    return { status: 200, body: updated };
  });
}

deliveriesRouter.post('/:id/accept', requireRole('driver'), async (request, response) => {
  const id = idParam.safeParse(request.params.id);
  if (!id.success) return response.status(400).json({ error: 'Invalid delivery ID' });
  const result = await driverTransition(id.data, request.user!.id, 'accept');
  return response.status(result.status).json(result.body);
});

deliveriesRouter.post('/:id/reject', requireRole('driver'), async (request, response) => {
  const id = idParam.safeParse(request.params.id);
  if (!id.success) return response.status(400).json({ error: 'Invalid delivery ID' });
  const result = await driverTransition(id.data, request.user!.id, 'reject');
  return response.status(result.status).json(result.body);
});

deliveriesRouter.post('/:id/status', requireRole('driver'), async (request, response) => {
  const id = idParam.safeParse(request.params.id);
  const status = nextStatus.safeParse(request.body?.status);
  if (!id.success || !status.success) return response.status(400).json({ error: 'Invalid delivery status request' });
  const result = await driverTransition(id.data, request.user!.id, status.data);
  return response.status(result.status).json(result.body);
});

deliveriesRouter.post('/:id/complete', requireRole('driver'), async (request, response) => {
  const id = idParam.safeParse(request.params.id);
  if (!id.success) return response.status(400).json({ error: 'Invalid delivery ID' });
  const result = await driverTransition(id.data, request.user!.id, 'DELIVERED');
  return response.status(result.status).json(result.body);
});

deliveriesRouter.post('/:id/cancel', requireRole('customer', 'admin'), async (request, response) => {
  const id = idParam.safeParse(request.params.id);
  if (!id.success) return response.status(400).json({ error: 'Invalid delivery ID' });
  const result = await transaction(async (client) => {
    const locked = await client.query<Delivery>('SELECT * FROM deliveries WHERE id = $1 FOR UPDATE', [id.data]);
    const delivery = locked.rows[0];
    if (!delivery) return { status: 404, body: { error: 'Delivery not found' } };
    if (request.user!.role !== 'admin' && delivery.customer_id !== request.user!.id) {
      return { status: 403, body: { error: 'Forbidden' } };
    }
    if (delivery.status === 'CANCELLED') return { status: 200, body: delivery };
    const allowed = request.user!.role === 'admin'
      ? !['DELIVERED', 'FAILED'].includes(delivery.status)
      : ['ASSIGNMENT_PENDING', 'DRIVER_ASSIGNED'].includes(delivery.status);
    if (!allowed) return { status: 409, body: { error: 'Delivery cannot be cancelled now' } };
    await client.query(
      `UPDATE driver_assignments SET status = 'CANCELLED', responded_at = NOW()
       WHERE delivery_id = $1 AND status IN ('OFFERED', 'ACCEPTED')`, [id.data],
    );
    return { status: 200, body: await changeStatus(client, delivery, 'CANCELLED', request.user!.id, 'DeliveryCancelled') };
  });
  return response.status(result.status).json(result.body);
});
