import 'dotenv/config';
import { createClient } from 'redis';

function makeClient() {
  return createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6380',
    disableOfflineQueue: true,
    socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 5_000) },
  });
}

export const redis = makeClient();
redis.on('error', (error) => console.error('Redis:', error));

let connecting: Promise<void> | null = null;
export async function connectedRedis() {
  if (!redis.isOpen) {
    connecting ??= redis.connect().then(() => undefined).finally(() => { connecting = null; });
    await connecting;
  }
  return redis;
}

export function newSubscriber() {
  const subscriber = makeClient();
  subscriber.on('error', (error) => console.error('Redis subscriber:', error));
  return subscriber;
}
