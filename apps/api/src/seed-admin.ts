import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { hashPassword } from './password.js';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!email || !password || password.length < 12) {
  throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters) in the API environment');
}

try {
  const existing = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (existing.rowCount) throw new Error('Admin email already exists');
  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role) VALUES ($1, $2, $3, $4, 'admin')`,
    [randomUUID(), email, 'FleetFlow Admin', await hashPassword(password)],
  );
  console.log(`Created admin: ${email}`);
} finally {
  await pool.end();
}
