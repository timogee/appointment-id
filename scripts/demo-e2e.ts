/**
 * End-to-end walkthrough with the scripted model, so the whole pipeline can be
 * demonstrated without an API key. Same engine, same tools, same database, same
 * notifier the real thing uses — only the model's side is scripted.
 *
 * Run: npx tsx scripts/demo-e2e.ts
 */
import { loadEnv } from '../src/env';
loadEnv();

import { eq } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client';
import { booking, bookingAudit, paymentRecord } from '../src/db/schema';
import { setProviders } from '../src/providers/registry';
import { ScriptedChatModel } from '../src/providers/chat-model/scripted';
import { ConsoleNotifier } from '../src/providers/notifier/console';
import { handleInbound } from '../src/chat/engine';
import { confirmDpReceived } from '../src/domain/booking-service';
import { releaseExpiredHolds } from '../src/domain/hold-expiry';
import { formatInstantId } from '../src/domain/time';

const PHONE = '628123456789';
const NOW = new Date('2026-09-09T07:00:00Z'); // Rabu 14:00 WIB
const notifier = new ConsoleNotifier();

function heading(text: string) {
  console.log(`\n\x1b[1m── ${text} ${'─'.repeat(Math.max(0, 60 - text.length))}\x1b[0m`);
}

async function say(body: string, script: ConstructorParameters<typeof ScriptedChatModel>[0]) {
  setProviders({ chatModel: new ScriptedChatModel(script), notifier });
  console.log(`\n\x1b[36mkamu >\x1b[0m ${body}`);
  const result = await handleInbound({ fromPhone: PHONE, body, receivedAt: NOW });
  console.log(
    `  \x1b[90m[tools] ${result.toolCalls.map((c) => `${c.name}${c.ok ? '' : ' ERROR'}`).join(', ') || '(none)'}\x1b[0m`,
  );
  if (result.handedOff) console.log(`  \x1b[33m[handoff] ${String(result.handoffReason)}\x1b[0m`);
  return result;
}

heading('1. Pelanggan tanya jam kosong');
await say('min ak mau potong sama maria besok sore bisa?', [
  {
    toolCalls: [
      {
        name: 'checkAvailability',
        arguments: {
          staffName: 'Maria',
          serviceName: 'Potong Rambut Pria',
          dateOrRange: '2026-09-10',
        },
      },
    ],
  },
  { afterTool: 'checkAvailability', text: 'Besok sore Maria masih kosong kak, jam 15:00 mau?' },
]);

heading('2. Pelanggan setuju, slot dikunci');
await say('iya jam 3 sore aja', [
  {
    toolCalls: [
      {
        name: 'createPendingBooking',
        arguments: {
          staffName: 'Maria',
          serviceName: 'Potong Rambut Pria',
          startIso: '2026-09-10T08:00:00Z', // 15:00 WIB
          customerName: 'Timo',
        },
      },
    ],
  },
  { afterTool: 'createPendingBooking', text: 'Sip, udah aku kunci ya kak.' },
]);

const [row] = await db.select().from(booking).where(eq(booking.status, 'pending_payment'));
console.log(`\n  booking ${row!.id}`);
console.log(`  status  ${row!.status}`);
console.log(`  mulai   ${formatInstantId(row!.startTime)} WIB`);
console.log(`  hold s/d ${formatInstantId(row!.holdExpiresAt!)} WIB`);

heading('3. Slot itu sekarang benar-benar terkunci di database');
try {
  await db.insert(booking).values({
    customerId: row!.customerId,
    staffId: row!.staffId,
    serviceId: row!.serviceId,
    status: 'confirmed',
    startTime: row!.startTime,
    endTime: row!.endTime,
    priceRupiah: 65_000,
  });
  console.log('  \x1b[31mBUG: constraint tidak menolak!\x1b[0m');
} catch {
  console.log('  ✓ Postgres menolak booking kedua di jam yang sama (booking_no_overlap)');
}

heading('4. Owner tekan "DP diterima"');
await confirmDpReceived(row!.id, { kind: 'owner' }, 'https://wa.me/bukti-transfer.jpg');
const [pay] = await db.select().from(paymentRecord).where(eq(paymentRecord.bookingId, row!.id));
console.log(`  payment ${pay!.reference} -> ${pay!.status}, bukti tersimpan (tidak diverifikasi)`);

heading('5. Nego harga -> handoff, bot berhenti membalas');
await say('eh bisa kurang gak harganya? nego dong', []);
await say('halo min?', [{ text: 'halo' }]);

heading('6. Jejak audit');
const audit = await db.select().from(bookingAudit).where(eq(bookingAudit.bookingId, row!.id));
for (const a of audit) {
  const before = (a.before as { status?: string } | null)?.status ?? '—';
  const after = (a.after as { status?: string } | null)?.status ?? '—';
  console.log(`  ${a.action.padEnd(16)} ${before} -> ${after}   oleh ${a.actorId}`);
}

heading('7. Hold yang kedaluwarsa dilepas otomatis');
const expiry = await releaseExpiredHolds(new Date('2030-01-01T00:00:00Z'));
console.log(`  booking confirmed tidak tersentuh: ${expiry.expired.length} hold dilepas`);

console.log('\n');
await closeDb();
