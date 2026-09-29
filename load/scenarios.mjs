import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config({ path: new URL('../apps/api/.env', import.meta.url) });

const base = process.env.BASE_URL ?? 'http://localhost:3001';
const wsUrl = process.env.WS_URL ?? base.replace(/^http/, 'ws') + '/ws';
const reads = positiveInteger('LOAD_READS', 500);
const writes = positiveInteger('LOAD_WRITES', 50);
const concurrency = positiveInteger('LOAD_CONCURRENCY', 25);
const socketCount = positiveInteger('LOAD_WS_CLIENTS', 100);
const gpsRate = positiveInteger('LOAD_GPS_PER_SECOND', 10);
const gpsSeconds = positiveInteger('LOAD_GPS_SECONDS', 5);
const sockets = [];

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(fraction * sorted.length) - 1] * 10) / 10;
}

async function api(path, method = 'GET', body, token, key) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function timedBatch(label, total, fn) {
  let next = 0;
  let failures = 0;
  const latencies = [];
  const errors = [];
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(total, concurrency) }, async () => {
    while (next < total) {
      const index = next++;
      const begin = performance.now();
      try { await fn(index); }
      catch (error) { failures++; if (errors.length < 3) errors.push(String(error)); }
      latencies.push(performance.now() - begin);
    }
  }));
  const seconds = (performance.now() - started) / 1_000;
  return {
    label, requests: total, concurrency: Math.min(total, concurrency), failures,
    requestsPerSecond: Math.round(total / seconds * 10) / 10,
    p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95), p99Ms: percentile(latencies, .99),
    ...(errors.length ? { errors } : {}),
  };
}

function waitMessage(ws, type, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, timeout);
    function cleanup() { clearTimeout(timer); ws.off('message', onMessage); ws.off('close', onClose); ws.off('error', onError); }
    function onMessage(raw) {
      let value;
      try { value = JSON.parse(raw.toString()); } catch { return; }
      if (value.type !== type) return;
      cleanup(); resolve(value);
    }
    function onClose() { cleanup(); reject(new Error(`Socket closed before ${type}`)); }
    function onError(error) { cleanup(); reject(error); }
    ws.on('message', onMessage); ws.on('close', onClose); ws.on('error', onError);
  });
}

async function openSocket(token, deliveryId) {
  const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000 });
  sockets.push(ws);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket open timeout')); }, 10_000);
    function cleanup() { clearTimeout(timer); ws.off('open', onOpen); ws.off('error', onError); }
    function onOpen() { cleanup(); resolve(); }
    function onError(error) { cleanup(); reject(error); }
    ws.on('open', onOpen); ws.on('error', onError);
  });
  const auth = waitMessage(ws, 'auth.ok');
  ws.send(JSON.stringify({ type: 'auth', token }));
  await auth;
  if (deliveryId) {
    const snapshot = waitMessage(ws, 'delivery.snapshot');
    ws.send(JSON.stringify({ type: 'subscribe', deliveryId }));
    await snapshot;
  }
  return ws;
}

try {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    throw new Error('Seed an admin and set ADMIN_EMAIL and ADMIN_PASSWORD in apps/api/.env');
  }
  const suffix = randomUUID();
  const password = `Load-${randomUUID()}`;
  const lat = -25 + Math.random() * 10;
  const lng = 50 + Math.random() * 10;
  const admin = await api('/api/auth/login', 'POST', {
    email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD,
  });
  const createdDriver = await api('/api/admin/drivers', 'POST', {
    fullName: 'Load Driver', email: `load-driver-${suffix}@example.test`, password,
  }, admin.token);
  const driver = await api('/api/auth/login', 'POST', {
    email: `load-driver-${suffix}@example.test`, password,
  });
  const customer = await api('/api/auth/register', 'POST', {
    fullName: 'Load Customer', email: `load-customer-${suffix}@example.test`, password,
  });
  await api('/api/drivers/me/online', 'POST', undefined, driver.token);
  await api('/api/drivers/me/location', 'PUT', { lat, lng }, driver.token);
  const deliveryInput = {
    pickup: { address: 'Load pickup', lat, lng },
    dropoff: { address: 'Load drop-off', lat: lat + .01, lng: lng + .01 },
  };
  const tracked = await api('/api/deliveries', 'POST', deliveryInput, customer.token, randomUUID());
  let assigned = false;
  for (let i = 0; i < 30; i++) {
    const detail = await api(`/api/deliveries/${tracked.id}`, 'GET', undefined, customer.token);
    if (detail.delivery.status === 'DRIVER_ASSIGNED' && detail.delivery.driver_id === createdDriver.driver.id) {
      assigned = true; break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!assigned) throw new Error('Test delivery was not assigned to its driver');

  const readResult = await timedBatch('authenticated delivery reads', reads,
    () => api(`/api/deliveries/${tracked.id}`, 'GET', undefined, customer.token));
  const writeResult = await timedBatch('idempotent delivery creates', writes,
    () => api('/api/deliveries', 'POST', {
      pickup: { address: 'Unassigned load pickup', lat: 80, lng: 0 },
      dropoff: { address: 'Unassigned load drop-off', lat: 80.01, lng: .01 },
    }, customer.token, randomUUID()));

  const clients = [];
  const connectStarted = performance.now();
  for (let i = 0; i < socketCount; i += 10) {
    clients.push(...await Promise.all(Array.from({ length: Math.min(10, socketCount - i) },
      () => openSocket(customer.token, tracked.id))));
  }
  const connectMs = performance.now() - connectStarted;
  const received = new Map(clients.map((ws) => [ws, 0]));
  const deliveryLatencies = [];
  for (const ws of clients) ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type !== 'location.update') return;
    received.set(ws, received.get(ws) + 1);
    deliveryLatencies.push(Math.max(0, Date.now() - Date.parse(message.timestamp)));
  });
  const driverSocket = await openSocket(driver.token);
  const sent = gpsRate * gpsSeconds;
  const sendStarted = performance.now();
  for (let i = 0; i < sent; i++) {
    driverSocket.send(JSON.stringify({ type: 'location.update', lat: lat + i * .000001, lng }));
    await new Promise((resolve) => setTimeout(resolve, 1000 / gpsRate));
  }
  const sendSeconds = (performance.now() - sendStarted) / 1000;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const counts = [...received.values()];
  const wsResult = {
    clients: socketCount, connectMs: Math.round(connectMs),
    gpsSent: sent, gpsSendSeconds: Math.round(sendSeconds * 10) / 10,
    clientsReceiving: counts.filter((count) => count > 0).length,
    messagesReceived: counts.reduce((sum, count) => sum + count, 0),
    messagesPerClientP50: percentile(counts, .5),
    deliveryLatencyP95Ms: percentile(deliveryLatencies, .95),
  };
  console.log(JSON.stringify({ environment: 'local', readResult, writeResult, wsResult }, null, 2));
  if (readResult.failures || writeResult.failures || wsResult.clientsReceiving !== socketCount) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.terminate();
}
