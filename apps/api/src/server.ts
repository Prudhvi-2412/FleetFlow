import express, { type ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import helmet from 'helmet';
import { authRouter } from './auth.js';
import { adminRouter } from './admin.js';
import { deliveriesRouter } from './deliveries.js';
import { driversRouter } from './drivers.js';
import { notificationsRouter } from './notifications.js';
import { attachWebSocket } from './websocket.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { ensureAdmin } from './seed-admin.js';

const app = express();
const port = Number(process.env.PORT ?? 3001);
if (!process.env.DATABASE_URL && (!process.env.PGHOST || !process.env.PGUSER || !process.env.PGPASSWORD || !process.env.PGDATABASE)) {
  throw new Error('DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE is required');
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
if (process.env.AUTO_MIGRATE === 'true') await migrate();
if (process.env.AUTO_SEED_ADMIN === 'true') await ensureAdmin();

app.use(helmet());
app.use(express.json({ limit: '16kb' }));
app.use('/api/auth', authRouter);
app.use('/api/deliveries', deliveriesRouter);
app.use('/api/drivers', driversRouter);
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationsRouter);

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', service: 'fleetflow-api' });
});

app.get('/api/ready', async (_request, response) => {
  try {
    await pool.query('SELECT 1');
    response.json({ status: 'ready' });
  } catch {
    response.status(503).json({ status: 'unavailable' });
  }
});

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'Internal server error' });
};
app.use(errorHandler);

const server = createServer(app);
const wss = attachWebSocket(server);
server.listen(port, () => {
  console.log(`FleetFlow API listening on http://localhost:${port}`);
});

function shutdown() {
  for (const client of wss.clients) client.close(1001, 'Server shutting down');
  wss.close();
  server.close(() => { void pool.end().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
