/**
 * Releases expired holds. Run on a timer in production (cron / a worker).
 * See src/domain/hold-expiry.ts for the logic.
 */
import { loadEnv } from '../src/env';
loadEnv();

import { closeDb } from '../src/db/client';
import { releaseExpiredHolds } from '../src/domain/hold-expiry';

const result = await releaseExpiredHolds();
console.log(
  result.expired.length === 0
    ? 'Tidak ada hold yang kedaluwarsa.'
    : `Melepas ${result.expired.length} hold:\n${result.expired.map((e) => `  ${e.bookingId} ${e.whenLabel} -> ${e.phone}`).join('\n')}`,
);
await closeDb();
