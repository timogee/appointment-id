import { loadEnv } from '@/env';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

loadEnv();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and run `docker compose up -d`.',
  );
}

/**
 * pg returns timestamptz as a local-zone Date by default, which is fine because a
 * Date is an instant. But it parses `date`/`time` as strings, which is what we want
 * for working_hours. No custom parsers needed.
 */
export const pool = new pg.Pool({ connectionString, max: 10 });

export const db = drizzle(pool, { schema });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run a query: the pool-backed db or an open transaction. */
export type Queryer = Db | Tx;

export async function closeDb(): Promise<void> {
  await pool.end();
}
