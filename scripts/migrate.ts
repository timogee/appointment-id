/**
 * Applies src/db/migrations/*.sql in filename order, tracking what ran.
 * Plain SQL on purpose: the exclusion constraint in 0001 is not expressible in
 * the Drizzle schema builder, and it is the one piece that must not be generated.
 */
import { loadEnv } from '../src/env';
loadEnv();
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = join(process.cwd(), 'src/db/migrations');

async function main() {
  const reset = process.argv.includes('--reset');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  if (reset) {
    console.log('Dropping public schema…');
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS _migration (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const applied = new Set(
    (await client.query<{ name: string }>('SELECT name FROM _migration')).rows.map((r) => r.name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO _migration (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  apply ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`  FAIL  ${file}`);
      throw error;
    }
  }

  const { rows } = await client.query(
    `SELECT conname FROM pg_constraint WHERE conname = 'booking_no_overlap'`,
  );
  if (rows.length === 0) {
    throw new Error('booking_no_overlap is MISSING. The overlap guarantee is gone. Stop and fix.');
  }
  console.log('booking_no_overlap present.');
  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
