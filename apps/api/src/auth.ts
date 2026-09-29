import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { SignJWT, errors, jwtVerify } from 'jose';
import { z } from 'zod';
import { pool } from './db.js';
import { hashPassword, verifyPassword } from './password.js';

export type Role = 'customer' | 'driver' | 'admin';
export type User = { id: string; email: string; full_name: string; role: Role };
type UserWithPassword = User & { password_hash: string };

const credentials = z.object({
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
});
const registration = credentials.extend({
  fullName: z.string().trim().min(1).max(120),
});

function signingKey(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return new TextEncoder().encode(secret);
}

export async function verifyAccessToken(token: string): Promise<User | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: 'fleetflow-api',
      audience: 'fleetflow-web',
      algorithms: ['HS256'],
    });
    if (!payload.sub) return null;
    const result = await pool.query<User>(
      'SELECT id, email, full_name, role FROM users WHERE id = $1',
      [payload.sub],
    );
    return result.rows[0] ?? null;
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }
}

export const requireAuth: RequestHandler = async (request, response, next) => {
  const match = /^Bearer (.+)$/.exec(request.header('authorization') ?? '');
  if (!match) return response.status(401).json({ error: 'Authentication required' });
  const user = await verifyAccessToken(match[1]!);
  if (!user) return response.status(401).json({ error: 'Invalid or expired token' });
  request.user = user;
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (request, response, next) => {
    if (!request.user) return response.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(request.user.role)) return response.status(403).json({ error: 'Forbidden' });
    next();
  };
}

async function issueToken(user: User): Promise<string> {
  return new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer('fleetflow-api')
    .setAudience('fleetflow-web')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(signingKey());
}

const authLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
export const authRouter = Router();

authRouter.post('/register', authLimiter, async (request, response) => {
  const parsed = registration.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Invalid registration details' });

  const { email, password, fullName } = parsed.data;
  const id = randomUUID();
  const passwordHash = await hashPassword(password);

  try {
    const result = await pool.query<User>(
      `INSERT INTO users (id, email, full_name, password_hash, role)
       VALUES ($1, $2, $3, $4, 'customer')
       RETURNING id, email, full_name, role`,
      [id, email, fullName, passwordHash],
    );
    const user = result.rows[0]!;
    return response.status(201).json({ user, token: await issueToken(user) });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return response.status(409).json({ error: 'Email already registered' });
    }
    throw error;
  }
});

authRouter.post('/login', authLimiter, async (request, response) => {
  const parsed = credentials.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Invalid credentials' });

  const result = await pool.query<UserWithPassword>(
    'SELECT id, email, full_name, role, password_hash FROM users WHERE email = $1',
    [parsed.data.email],
  );
  const user = result.rows[0];
  if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
    return response.status(401).json({ error: 'Invalid credentials' });
  }

  const { password_hash: _passwordHash, ...publicUser } = user;
  return response.json({ user: publicUser, token: await issueToken(publicUser) });
});

authRouter.get('/me', requireAuth, (request, response) => {
  response.json({ user: request.user });
});
