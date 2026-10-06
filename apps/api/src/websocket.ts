import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { verifyAccessToken, type User } from './auth.js';
import { pool } from './db.js';
import { updateLocation } from './locations.js';
import { connectedRedis, newSubscriber } from './redis.js';

type Client = {
  socket: WebSocket;
  user: User | null;
  subscriptions: Map<string, string | null>;
  count: number;
  windowStarted: number;
  queue: Promise<void>;
  pending: number;
  alive: boolean;
};

const clients = new Set<Client>();
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1) }),
  z.object({ type: z.literal('subscribe'), deliveryId: z.uuid() }),
  z.object({ type: z.literal('unsubscribe'), deliveryId: z.uuid() }),
  z.object({ type: z.literal('location.update'), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  z.object({ type: z.literal('ping') }),
]);

function send(client: Client, payload: Record<string, unknown>) {
  if (client.socket.readyState !== WebSocket.OPEN) return;
  if (client.socket.bufferedAmount > 256_000) {
    client.socket.close(1013, 'Slow consumer');
    return;
  }
  client.socket.send(JSON.stringify(payload));
}

async function onMessage(client: Client, raw: Buffer) {
  const now = Date.now();
  if (now - client.windowStarted >= 1_000) {
    client.windowStarted = now;
    client.count = 0;
  }
  client.count++;
  if (client.count > 20) return;

  let data: unknown;
  try { data = JSON.parse(raw.toString()); } catch { send(client, { type: 'error', message: 'Invalid JSON' }); return; }
  const parsed = messageSchema.safeParse(data);
  if (!parsed.success) { send(client, { type: 'error', message: 'Invalid message' }); return; }
  const message = parsed.data;

  if (message.type === 'auth') {
    if (client.user) return;
    client.user = await verifyAccessToken(message.token);
    if (!client.user) { client.socket.close(1008, 'Invalid token'); return; }
    send(client, { type: 'auth.ok', user: client.user });
    return;
  }
  if (!client.user) { client.socket.close(1008, 'Authenticate first'); return; }
  if (message.type === 'ping') { send(client, { type: 'pong' }); return; }
  if (message.type === 'unsubscribe') { client.subscriptions.delete(message.deliveryId); return; }

  if (message.type === 'subscribe') {
    const result = await pool.query<{ customer_id: string; driver_id: string | null }>(
      'SELECT customer_id, driver_id FROM deliveries WHERE id = $1', [message.deliveryId],
    );
    const delivery = result.rows[0];
    if (!delivery || (client.user.role !== 'admin' && client.user.id !== delivery.customer_id && client.user.id !== delivery.driver_id)) {
      send(client, { type: 'error', message: 'Delivery not available' });
      return;
    }
    client.subscriptions.set(message.deliveryId, delivery.driver_id);
    let location: unknown = null;
    if (delivery.driver_id) {
      try {
        const redis = await connectedRedis();
        const latest = await redis.get(`driver:location:${delivery.driver_id}`);
        location = latest ? JSON.parse(latest) : null;
      } catch { /* Delivery status remains available if hot state is unavailable. */ }
    }
    send(client, { type: 'delivery.snapshot', deliveryId: message.deliveryId, driverId: delivery.driver_id, location });
    return;
  }

  if (message.type === 'location.update') {
    if (client.user.role !== 'driver') { send(client, { type: 'error', message: 'Driver role required' }); return; }
    const result = await updateLocation(client.user.id, message.lat, message.lng);
    if (!result.accepted) send(client, { type: 'error', message: result.reason });
  }
}

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const expectedOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    let originAllowed = !request.headers.origin || request.headers.origin === expectedOrigin;
    if (expectedOrigin === 'same-host' && request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin);
        originAllowed = origin.protocol === 'https:' && origin.host === request.headers.host;
      } catch { originAllowed = false; }
    }
    if (path !== '/ws' || !originAllowed) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (socket) => {
    const client: Client = { socket, user: null, subscriptions: new Map(), count: 0, windowStarted: Date.now(), queue: Promise.resolve(), pending: 0, alive: true };
    clients.add(client);
    const authTimeout = setTimeout(() => { if (!client.user) socket.close(1008, 'Authentication timeout'); }, 5_000);
    socket.on('message', (data) => {
      if (client.pending >= 20) return;
      client.pending++;
      const bytes = Buffer.from(data as Buffer);
      client.queue = client.queue.then(() => onMessage(client, bytes)).catch((error) => {
        console.error('WebSocket message:', error);
        send(client, { type: 'error', message: 'Temporary server error' });
      }).finally(() => { client.pending--; });
    });
    socket.on('pong', () => { client.alive = true; });
    socket.on('close', () => { clearTimeout(authTimeout); clients.delete(client); });
    socket.on('error', (error) => console.error('WebSocket:', error));
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) { client.socket.terminate(); continue; }
      client.alive = false;
      client.socket.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  const subscriber = newSubscriber();
  void subscriber.connect().then(() => subscriber.subscribe('fleetflow:events', (raw) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    for (const client of clients) {
      if (!client.user) continue;
      if (message.type === 'location.update') {
        if ([...client.subscriptions.values()].includes(message.driverId as string)) send(client, message);
      } else if (message.type === 'delivery.event') {
        const deliveryId = message.deliveryId as string;
        const recipient = client.user.role === 'admin'
          ? client.subscriptions.has(deliveryId)
          : client.user.id === message.customerId || client.user.id === message.driverId;
        if (!recipient) continue;
        if (client.subscriptions.has(deliveryId) && message.eventType === 'DriverAssigned') {
          client.subscriptions.set(deliveryId, message.driverId as string);
        }
        send(client, message);
      }
    }
  })).catch((error) => console.error('WebSocket event subscription:', error));

  return wss;
}
