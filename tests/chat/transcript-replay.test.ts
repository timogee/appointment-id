/**
 * Replays the fixtures in tests/chat/transcripts/ against ScriptedChatModel.
 *
 * What is real here: the tools, the date parser, the escalation rules, the
 * booking service, and Postgres. Only the model's side is scripted, so the suite
 * runs offline and deterministically while still exercising the contract that
 * matters — which tool ran with which arguments.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb, db } from '../../src/db/client';
import { booking, customer } from '../../src/db/schema';
import { ScriptedChatModel, type ScriptedStep } from '../../src/providers/chat-model/scripted';
import { ConsoleNotifier } from '../../src/providers/notifier/console';
import { setProviders, resetProviders } from '../../src/providers/registry';
import { handleInbound } from '../../src/chat/engine';
import { createPendingBooking, confirmDpReceived } from '../../src/domain/booking-service';
import { jakartaToUtc, addMinutes } from '../../src/domain/time';
import { resetDb, seedFixture, type Fixture } from '../helpers/db';

interface Turn {
  user: string;
  script: ScriptedStep[];
  expectTools?: Array<{ name: string; arguments?: Record<string, unknown> }>;
  expectHandoff?: boolean;
  expectNoReply?: boolean;
  expectModelCalls?: number;
  comment?: string;
}

interface Transcript {
  name: string;
  now: string;
  phone: string;
  setup?: {
    bookings?: Array<{ staff: string; service: string; startIso: string }>;
    fillDay?: { staff: string; date: string; fromTime: string; toTime: string };
  };
  turns: Turn[];
}

const DIR = join(import.meta.dirname, 'transcripts');
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

let fx: Fixture;

beforeEach(async () => {
  await resetDb();
  fx = await seedFixture();
  setProviders({ notifier: new ConsoleNotifier() });
});

afterAll(async () => {
  resetProviders();
  await closeDb();
});

/** Fill a staff member's day so alternatives have something to route around. */
async function fillDay(phone: string, spec: NonNullable<Transcript['setup']>['fillDay']) {
  if (!spec) return;
  let start = jakartaToUtc(spec.date, spec.fromTime);
  const until = jakartaToUtc(spec.date, spec.toTime);
  while (start < until) {
    const { booking: row } = await createPendingBooking({
      customerPhone: `${phone}9`,
      staffId: fx.staff[spec.staff]!,
      serviceId: fx.services['Potong Rambut Pria']!,
      startTime: start,
      actor: { kind: 'owner' },
    });
    await confirmDpReceived(row.id, { kind: 'owner' });
    start = addMinutes(start, 55);
  }
}

async function applySetup(t: Transcript): Promise<string[]> {
  const ids: string[] = [];
  for (const b of t.setup?.bookings ?? []) {
    const { booking: row } = await createPendingBooking({
      customerPhone: t.phone,
      staffId: fx.staff[b.staff]!,
      serviceId: fx.services[b.service]!,
      startTime: new Date(b.startIso),
      actor: { kind: 'customer', phone: t.phone },
    });
    ids.push(row.id);
  }
  await fillDay(t.phone, t.setup?.fillDay);
  return ids;
}

/** Fixtures cannot know generated ids, so they reference them as {{booking.N.id}}. */
function resolvePlaceholders(script: ScriptedStep[], bookingIds: string[]): ScriptedStep[] {
  const swap = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const m = value.match(/^\{\{booking\.(\d+)\.id\}\}$/);
    return m ? bookingIds[Number(m[1])] : value;
  };
  return script.map((step) => ({
    ...step,
    toolCalls: step.toolCalls?.map((c) => ({
      ...c,
      arguments: Object.fromEntries(Object.entries(c.arguments).map(([k, v]) => [k, swap(v)])),
    })),
  }));
}

describe('transcript replay', () => {
  for (const file of files) {
    const transcript = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Transcript;

    it(`${file}: ${transcript.name}`, async () => {
      const bookingIds = await applySetup(transcript);

      for (const [index, turn] of transcript.turns.entries()) {
        const model = new ScriptedChatModel(resolvePlaceholders(turn.script, bookingIds));
        setProviders({ chatModel: model, notifier: new ConsoleNotifier() });

        const result = await handleInbound({
          fromPhone: transcript.phone,
          body: turn.user,
          receivedAt: new Date(transcript.now),
        });

        const label = `turn ${index} ("${turn.user}")`;

        if (turn.expectModelCalls !== undefined) {
          expect(model.calls, `${label}: model calls`).toBe(turn.expectModelCalls);
        }

        for (const [i, expected] of (turn.expectTools ?? []).entries()) {
          const actual = result.toolCalls[i];
          expect(actual, `${label}: expected tool #${i} ${expected.name}`).toBeDefined();
          expect(actual!.name, `${label}: tool #${i} name`).toBe(expected.name);
          for (const [key, value] of Object.entries(expected.arguments ?? {})) {
            expect(actual!.arguments[key], `${label}: tool #${i} arg ${key}`).toEqual(value);
          }
          expect(actual!.ok, `${label}: tool #${i} ${expected.name} must succeed`).toBe(true);
        }

        if (turn.expectTools) {
          expect(
            result.toolCalls.map((c) => c.name),
            `${label}: exact tool sequence`,
          ).toEqual(turn.expectTools.map((t) => t.name));
        }

        expect(result.handedOff, `${label}: handoff`).toBe(turn.expectHandoff ?? false);
        if (turn.expectNoReply) {
          expect(result.reply, `${label}: must not reply`).toBeNull();
        }
      }
    });
  }
});

describe('effects the transcripts must actually have had', () => {
  it('really cancels the Saturday booking in 04', async () => {
    const transcript = JSON.parse(
      readFileSync(join(DIR, '04-batalin-yang-sabtu.json'), 'utf8'),
    ) as Transcript;
    const ids = await applySetup(transcript);

    const turn = transcript.turns[0]!;
    setProviders({
      chatModel: new ScriptedChatModel(resolvePlaceholders(turn.script, ids)),
      notifier: new ConsoleNotifier(),
    });
    await handleInbound({
      fromPhone: transcript.phone,
      body: turn.user,
      receivedAt: new Date(transcript.now),
    });

    const rows = await db.select().from(booking);
    expect(rows).toHaveLength(1);
    // Cancelled, not deleted — and the slot is free again.
    expect(rows[0]!.status).toBe('cancelled');
  });

  it('records the customer against their phone number', async () => {
    const transcript = JSON.parse(
      readFileSync(join(DIR, '04-batalin-yang-sabtu.json'), 'utf8'),
    ) as Transcript;
    await applySetup(transcript);
    const rows = await db.select().from(customer);
    expect(rows.map((r) => r.phone)).toContain(transcript.phone);
  });
});
