import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { pool } from '../src/db.js';

const base = process.env.SMOKE_BASE_URL ?? 'http://localhost:3001';
const wsBase = base.replace(/^http/, 'ws');
const customerEmail = `customer-${randomUUID()}@example.test`;
const driverEmail = `driver-${randomUUID()}@example.test`;
const password = `Test-${randomUUID()}`;
const originLat = 20 + Math.random() * 30;
const originLng = -120 + Math.random() * 60;
const raceLat = -40 + Math.random() * 15;
const raceLng = 100 + Math.random() * 40;

async function request(path: string, method = 'GET', body?: unknown, token?: string, key?: string) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() as any };
}

async function waitForStatus(deliveryId: string, token: string, status: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await request(`/api/deliveries/${deliveryId}`, 'GET', undefined, token);
    if (result.data.delivery?.status === status) return result.data.delivery;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${status}`);
}

const admin = await request('/api/auth/login', 'POST', {
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
});
assert.equal(admin.status, 200, 'Seed an admin before running smoke tests');
const adminToken = admin.data.token as string;

const createdDriver = await request('/api/admin/drivers', 'POST', {
  fullName: 'Smoke Driver', email: driverEmail, password,
  vehicleLabel: 'Bike', plateNumber: `TEST-${randomUUID().slice(0, 8)}`,
}, adminToken);
assert.equal(createdDriver.status, 201);
const driver = await request('/api/auth/login', 'POST', { email: driverEmail, password });
assert.equal(driver.status, 200);
const driverToken = driver.data.token as string;

const online = await request('/api/drivers/me/online', 'POST', undefined, driverToken);
assert.equal(online.status, 200);
const location = await request('/api/drivers/me/location', 'PUT', { lat: originLat, lng: originLng }, driverToken);
assert.equal(location.status, 200);

const customer = await request('/api/auth/register', 'POST', {
  fullName: 'Smoke Customer', email: customerEmail, password,
});
assert.equal(customer.status, 201);
const customerToken = customer.data.token as string;
const forbidden = await request('/api/admin/metrics', 'GET', undefined, customerToken);
assert.equal(forbidden.status, 403);
const deliveryInput = {
  pickup: { address: 'Test pickup', lat: originLat, lng: originLng },
  dropoff: { address: 'Test drop-off', lat: originLat + 0.01, lng: originLng + 0.01 },
};
const key = randomUUID();
const created = await request('/api/deliveries', 'POST', deliveryInput, customerToken, key);
assert.equal(created.status, 201);
const repeated = await request('/api/deliveries', 'POST', deliveryInput, customerToken, key);
assert.equal(repeated.data.id, created.data.id);
const changed = await request('/api/deliveries', 'POST', { ...deliveryInput, dropoff: { ...deliveryInput.dropoff, address: 'Another address' } }, customerToken, key);
assert.equal(changed.status, 409);

const deliveryId = created.data.id as string;
await waitForStatus(deliveryId, customerToken, 'DRIVER_ASSIGNED');

function waitWs(ws: WebSocket, type: string, timeoutMs = 5_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`WebSocket ${type} timeout`)); }, timeoutMs);
    function onMessage(raw: WebSocket.RawData) {
      const message = JSON.parse(raw.toString()) as { type: string };
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}
async function openAuthenticated(token: string) {
  const ws = new WebSocket(`${wsBase}/ws`);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const authorized = waitWs(ws, 'auth.ok');
  ws.send(JSON.stringify({ type: 'auth', token }));
  await authorized;
  return ws;
}
const customerSocket = await openAuthenticated(customerToken);
const snapshot = waitWs(customerSocket, 'delivery.snapshot');
customerSocket.send(JSON.stringify({ type: 'subscribe', deliveryId }));
assert.equal((await snapshot).deliveryId, deliveryId);
const driverSocket = await openAuthenticated(driverToken);
await new Promise((resolve) => setTimeout(resolve, 1_100));
const locationEvent = waitWs(customerSocket, 'location.update');
driverSocket.send(JSON.stringify({ type: 'location.update', lat: originLat + 0.001, lng: originLng + 0.001 }));
assert.equal((await locationEvent).driverId, createdDriver.data.driver.id);
customerSocket.close();
driverSocket.close();

const accepted = await request(`/api/deliveries/${deliveryId}/accept`, 'POST', undefined, driverToken);
assert.equal(accepted.data.status, 'ACCEPTED');
for (const status of ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED']) {
  const updated = await request(`/api/deliveries/${deliveryId}/status`, 'POST', { status }, driverToken);
  assert.equal(updated.data.status, status);
}
const complete = await request(`/api/deliveries/${deliveryId}/complete`, 'POST', undefined, driverToken);
assert.equal(complete.data.status, 'DELIVERED');
const duplicateComplete = await request(`/api/deliveries/${deliveryId}/complete`, 'POST', undefined, driverToken);
assert.equal(duplicateComplete.data.status, 'DELIVERED');
const detail = await request(`/api/deliveries/${deliveryId}`, 'GET', undefined, customerToken);
assert.equal(detail.data.history.filter((row: any) => row.to_status === 'DELIVERED').length, 1);

for (let attempt = 0; attempt < 20; attempt++) {
  const notifications = await request('/api/notifications', 'GET', undefined, customerToken);
  if (notifications.data.notifications.some((row: any) => row.title === 'Delivery completed')) break;
  if (attempt === 19) throw new Error('Completion notification was not produced');
  await new Promise((resolve) => setTimeout(resolve, 300));
}

const metrics = await request('/api/admin/metrics', 'GET', undefined, adminToken);
assert.equal(metrics.status, 200);

const remoteInput = {
  pickup: { address: 'Remote pickup', lat: 0, lng: 0 },
  dropoff: { address: 'Remote drop-off', lat: 0.01, lng: 0.01 },
};
const cancellable = await request('/api/deliveries', 'POST', remoteInput, customerToken, randomUUID());
assert.equal(cancellable.status, 201);
const cancelled = await request(`/api/deliveries/${cancellable.data.id}/cancel`, 'POST', undefined, customerToken);
assert.equal(cancelled.data.status, 'CANCELLED');
const repeatCancel = await request(`/api/deliveries/${cancellable.data.id}/cancel`, 'POST', undefined, customerToken);
assert.equal(repeatCancel.data.status, 'CANCELLED');

const failing = await request('/api/deliveries', 'POST', remoteInput, customerToken, randomUUID());
assert.equal(failing.status, 201);
const failed = await request(`/api/admin/deliveries/${failing.data.id}/fail`, 'POST', { reason: 'Test dispatch failure' }, adminToken);
assert.equal(failed.data.status, 'FAILED');
assert.equal(failed.data.failure_reason, 'Test dispatch failure');

const raceDriverEmail = `race-driver-${randomUUID()}@example.test`;
const raceDriver = await request('/api/admin/drivers', 'POST', {
  fullName: 'Race Driver', email: raceDriverEmail, password,
}, adminToken);
assert.equal(raceDriver.status, 201);
const berlinInput = {
  pickup: { address: 'Race pickup', lat: raceLat, lng: raceLng },
  dropoff: { address: 'Race drop-off', lat: raceLat + 0.01, lng: raceLng + 0.01 },
};
const [first, second] = await Promise.all([
  request('/api/deliveries', 'POST', berlinInput, customerToken, randomUUID()),
  request('/api/deliveries', 'POST', berlinInput, customerToken, randomUUID()),
]);
assert.equal(first.status, 201);
assert.equal(second.status, 201);
const raceLogin = await request('/api/auth/login', 'POST', { email: raceDriverEmail, password });
assert.equal(raceLogin.status, 200);
await request('/api/drivers/me/online', 'POST', undefined, raceLogin.data.token);
await request('/api/drivers/me/location', 'PUT', { lat: raceLat, lng: raceLng }, raceLogin.data.token);
const assignments = await Promise.all([
  request(`/api/admin/deliveries/${first.data.id}/assign`, 'POST', { driverId: raceDriver.data.driver.id }, adminToken),
  request(`/api/admin/deliveries/${second.data.id}/assign`, 'POST', { driverId: raceDriver.data.driver.id }, adminToken),
]);
assert.deepEqual(assignments.map((item) => item.status).sort(), [200, 409]);
if (!process.env.SMOKE_BASE_URL) {
  const active = await pool.query(
    "SELECT COUNT(*)::int AS count FROM driver_assignments WHERE driver_id = $1 AND status IN ('OFFERED', 'ACCEPTED')",
    [raceDriver.data.driver.id],
  );
  assert.equal(active.rows[0].count, 1);
  await pool.end();
}
console.log('Smoke test passed: roles, tracking, idempotency, lifecycle, cancellation, failure, notifications, metrics, concurrent assignment');
