import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from './db.js';
import { hashPassword } from './password.js';

export async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters) in the API environment');
  }
  const existing = await pool.query<{ role: string }>('SELECT role FROM users WHERE email = $1', [email]);
  if (existing.rows[0]?.role === 'admin') return;
  if (existing.rowCount) throw new Error('Admin email already belongs to a different role');
  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role) VALUES ($1, $2, $3, $4, 'admin')`,
    [randomUUID(), email, 'FleetFlow Admin', await hashPassword(password)],
  );
  console.log(`Created admin: ${email}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await ensureAdmin(); } finally { await pool.end(); }
}
