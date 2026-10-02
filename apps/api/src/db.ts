import 'dotenv/config';
import pg from 'pg';
import { readFileSync } from 'node:fs';

export const pool = new pg.Pool({
  ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  }),
  ...(process.env.PGSSLROOTCERT ? { ssl: { ca: readFileSync(process.env.PGSSLROOTCERT, 'utf8'), rejectUnauthorized: true } } : {}),
});
