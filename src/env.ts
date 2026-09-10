/**
 * Loads .env for scripts and tests. Next.js already does this for the app, so
 * this is a no-op there. Uses Node's built-in loader — no dotenv dependency.
 */
import { existsSync } from 'node:fs';

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  if (typeof process.loadEnvFile === 'function' && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
}
