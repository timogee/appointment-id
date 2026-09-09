/**
 * The complete set of actions available to the LLM. Six tools, nothing else.
 *
 * Hard boundaries enforced here, not by prompting:
 *   - No SQL reaches the model. Tools take names and ISO strings, not queries.
 *   - No date arithmetic happens on the model's side. Tools accept a date that
 *     src/chat/date-parser.ts already resolved, or a plain 'YYYY-MM-DD'.
 *   - Staff and service names are resolved against the database. An unknown name
 *     is an error the model must relay, not a name it may invent.
 *
 * Every value a customer sees — a time, a price, a staff name — leaves the system
 * through a tool result. See src/chat/engine.ts for how that is enforced.
 */
import { and, eq, ilike } from 'drizzle-orm';
import { db } from '@/db/client';
import { service, staff, chatSession } from '@/db/schema';
import { DomainError, NotFoundError, SlotTakenError } from '@/db/errors';
import { ALTERNATIVE_SEARCH_DAYS, DP_AMOUNT_RUPIAH } from '@/config/business';
import { formatRupiah } from '@/domain/money';
import {
  formatDateId,
  formatInstantId,
  jakartaDateKey,
  nextDate,
  utcToJakartaTime,
  type JakartaDate,
} from '@/domain/time';
import { getAvailableSlots, suggestAlternatives, type Slot } from '@/domain/availability';
import {
  buildAvailabilityInput,
  buildPerStaffInputs,
  loadQualifiedStaff,
} from '@/domain/availability-inputs';
import {
  cancelBooking,
  createPendingBooking,
  getBookingsForPhone,
  getBooking,
} from '@/domain/booking-service';
import type { ToolSpec } from '@/providers/chat-model/types';

export interface ToolContext {
  customerPhone: string;
  now: Date;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

// ---------------------------------------------------------------- name resolution

async function resolveService(name: string) {
  const [row] = await db
    .select()
    .from(service)
    .where(and(ilike(service.name, `%${name}%`), eq(service.active, true)))
    .limit(1);
  if (!row) throw new NotFoundError(`Layanan "${name}"`);
  return row;
}

async function resolveStaff(name: string) {
  const [row] = await db
    .select()
    .from(staff)
    .where(and(ilike(staff.name, `%${name}%`), eq(staff.active, true)))
    .limit(1);
  if (!row) throw new NotFoundError(`Staff "${name}"`);
  return row;
}

/** Slots become plain, already-formatted values. The model never formats a time. */
function renderSlot(slot: Slot) {
  return {
    startIso: slot.start.toISOString(),
    time: utcToJakartaTime(slot.start),
    endTime: utcToJakartaTime(slot.end),
  };
}

function datesFrom(dateOrRange: string, now: Date): JakartaDate[] {
  // Accepts 'YYYY-MM-DD' or 'YYYY-MM-DD..YYYY-MM-DD'. The engine resolved any
  // Indonesian phrasing before this point.
  const [from, to] = dateOrRange.split('..');
  const start = (from ?? jakartaDateKey(now)).trim();
  if (!to) return [start];
  const out: JakartaDate[] = [];
  for (let d = start, i = 0; d <= to.trim() && i < 31; d = nextDate(d), i += 1) out.push(d);
  return out;
}

// ---------------------------------------------------------------- the six tools

export const TOOL_SPECS: ReadonlyArray<ToolSpec> = [
  {
    name: 'checkAvailability',
    description:
      'Cek jam kosong untuk satu layanan pada tanggal tertentu. Kalau staffName kosong, cek semua staff yang bisa layanan itu. Selalu pakai tool ini sebelum menyebut jam apa pun.',
    inputSchema: {
      type: 'object',
      properties: {
        staffName: { type: 'string', description: 'Nama staff, opsional.' },
        serviceName: { type: 'string', description: 'Nama layanan.' },
        dateOrRange: {
          type: 'string',
          description: "Tanggal 'YYYY-MM-DD' atau rentang 'YYYY-MM-DD..YYYY-MM-DD'.",
        },
      },
      required: ['serviceName', 'dateOrRange'],
    },
  },
  {
    name: 'suggestAlternatives',
    description:
      'Kalau jam yang diminta penuh, pakai ini untuk dapat jam lain dengan staff yang sama, dan jam yang sama dengan staff lain.',
    inputSchema: {
      type: 'object',
      properties: {
        staffName: { type: 'string' },
        serviceName: { type: 'string' },
        dateOrRange: { type: 'string' },
        wantedStartIso: {
          type: 'string',
          description: 'Jam yang tadi diminta, format ISO UTC. Opsional.',
        },
      },
      required: ['staffName', 'serviceName', 'dateOrRange'],
    },
  },
  {
    name: 'createPendingBooking',
    description:
      'Kunci slot untuk pelanggan. Hanya panggil kalau jamnya sudah dikonfirmasi pelanggan DAN sudah muncul di hasil checkAvailability.',
    inputSchema: {
      type: 'object',
      properties: {
        staffName: { type: 'string' },
        serviceName: { type: 'string' },
        startIso: { type: 'string', description: 'Jam mulai, ISO UTC, persis dari hasil tool.' },
        customerName: { type: 'string' },
      },
      required: ['staffName', 'serviceName', 'startIso'],
    },
  },
  {
    name: 'getBookingsForPhone',
    description: 'Lihat booking aktif milik pelanggan yang sedang chat.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cancelBooking',
    description:
      'Batalkan satu booking milik pelanggan ini. Butuh bookingId dari getBookingsForPhone.',
    inputSchema: {
      type: 'object',
      properties: { bookingId: { type: 'string' } },
      required: ['bookingId'],
    },
  },
  {
    name: 'handoffToOwner',
    description:
      'Serahkan percakapan ke pemilik. Wajib dipakai untuk komplain, tawar harga, atau apa pun di luar booking. Setelah ini, jangan balas lagi.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
];

export const TOOL_NAMES = TOOL_SPECS.map((t) => t.name);

// ---------------------------------------------------------------- executors

type Executor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new DomainError(`Argumen "${key}" wajib diisi.`);
  }
  return v.trim();
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

const EXECUTORS: Record<string, Executor> = {
  async checkAvailability(args, ctx) {
    const svc = await resolveService(str(args, 'serviceName'));
    const dates = datesFrom(str(args, 'dateOrRange'), ctx.now);
    const staffName = optStr(args, 'staffName');

    const targets = staffName
      ? [await resolveStaff(staffName)].map((s) => ({ id: s.id, name: s.name }))
      : await loadQualifiedStaff(db, svc.id);

    const results = [];
    for (const s of targets) {
      for (const date of dates) {
        const input = await buildAvailabilityInput(db, {
          staffId: s.id,
          serviceId: svc.id,
          date,
          notBefore: ctx.now,
        });
        if (input.workingWindows.length === 0) {
          results.push({
            staffName: s.name,
            date,
            dateLabel: formatDateId(date),
            closed: true,
            slots: [],
          });
          continue;
        }
        results.push({
          staffName: s.name,
          date,
          dateLabel: formatDateId(date),
          closed: false,
          slots: getAvailableSlots(input).map(renderSlot),
        });
      }
    }

    return {
      service: {
        name: svc.name,
        priceLabel: formatRupiah(svc.priceRupiah),
        durationMinutes: svc.durationMinutes,
      },
      results,
      anyAvailable: results.some((r) => r.slots.length > 0),
    };
  },

  async suggestAlternatives(args, ctx) {
    const svc = await resolveService(str(args, 'serviceName'));
    const preferred = await resolveStaff(str(args, 'staffName'));
    const dates = datesFrom(str(args, 'dateOrRange'), ctx.now);
    // Widen a little: the point of this tool is to find something, not to confirm nothing.
    const widened =
      dates.length === 1
        ? Array.from({ length: ALTERNATIVE_SEARCH_DAYS }, (_, i) => nextDate(dates[0]!, i))
        : dates;

    const perStaff = await buildPerStaffInputs(db, {
      serviceId: svc.id,
      dates: widened,
      notBefore: ctx.now,
    });

    const wantedIso = optStr(args, 'wantedStartIso');
    const alt = suggestAlternatives({
      perStaff,
      preferredStaffId: preferred.id,
      ...(wantedIso ? { wantedStart: new Date(wantedIso) } : {}),
    });

    const render = (e: { staffName: string; slot: Slot }) => ({
      staffName: e.staffName,
      dateLabel: formatDateId(jakartaDateKey(e.slot.start)),
      ...renderSlot(e.slot),
    });

    return {
      service: { name: svc.name, priceLabel: formatRupiah(svc.priceRupiah) },
      preferredStaff: preferred.name,
      sameStaffOtherTimes: alt.sameStaffOtherTimes.map(render),
      sameTimeOtherStaff: alt.sameTimeOtherStaff.map(render),
    };
  },

  async createPendingBooking(args, ctx) {
    const svc = await resolveService(str(args, 'serviceName'));
    const staffRow = await resolveStaff(str(args, 'staffName'));
    const startTime = new Date(str(args, 'startIso'));
    if (Number.isNaN(startTime.getTime())) {
      throw new DomainError('Format jam tidak valid.');
    }

    try {
      const result = await createPendingBooking({
        customerPhone: ctx.customerPhone,
        ...(optStr(args, 'customerName') ? { customerName: optStr(args, 'customerName')! } : {}),
        staffId: staffRow.id,
        serviceId: svc.id,
        startTime,
        source: 'chat',
        now: ctx.now,
        actor: { kind: 'customer', phone: ctx.customerPhone },
      });

      return {
        bookingId: result.booking.id,
        staffName: staffRow.name,
        serviceName: svc.name,
        whenLabel: formatInstantId(result.booking.startTime),
        priceLabel: formatRupiah(svc.priceRupiah),
        dpLabel: formatRupiah(DP_AMOUNT_RUPIAH),
        paymentInstructions: result.dp.instructions,
        holdExpiresLabel: formatInstantId(result.booking.holdExpiresAt!),
      };
    } catch (error) {
      if (error instanceof SlotTakenError) {
        // The DB constraint refused it. Surface this as a normal outcome so the
        // model offers alternatives instead of insisting the booking worked.
        return { failed: 'SLOT_TAKEN', message: error.message };
      }
      throw error;
    }
  },

  async getBookingsForPhone(_args, ctx) {
    const rows = await getBookingsForPhone(ctx.customerPhone);
    const out = [];
    for (const b of rows) {
      const [svc] = await db.select().from(service).where(eq(service.id, b.serviceId)).limit(1);
      const [st] = await db.select().from(staff).where(eq(staff.id, b.staffId)).limit(1);
      out.push({
        bookingId: b.id,
        status: b.status,
        staffName: st?.name ?? '?',
        serviceName: svc?.name ?? '?',
        whenLabel: formatInstantId(b.startTime),
        startIso: b.startTime.toISOString(),
      });
    }
    return { bookings: out };
  },

  async cancelBooking(args, ctx) {
    const bookingId = str(args, 'bookingId');
    const row = await getBooking(db, bookingId);
    // A phone may only cancel its own booking. The model cannot be talked into
    // cancelling someone else's because this check is here, not in the prompt.
    const owned = await getBookingsForPhone(ctx.customerPhone, { includeTerminal: true });
    if (!owned.some((b) => b.id === row.id)) {
      throw new DomainError('Booking itu bukan atas nomor ini.');
    }
    const updated = await cancelBooking(bookingId, { kind: 'customer', phone: ctx.customerPhone });
    return {
      bookingId: updated.id,
      status: updated.status,
      whenLabel: formatInstantId(updated.startTime),
    };
  },

  async handoffToOwner(args, ctx) {
    const reason = str(args, 'reason');
    await db
      .insert(chatSession)
      .values({
        phone: ctx.customerPhone,
        handedOff: true,
        handoffReason: reason,
        handoffAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: chatSession.phone,
        set: { handedOff: true, handoffReason: reason, handoffAt: ctx.now, updatedAt: ctx.now },
      });
    return { handedOff: true, reason };
  },
};

/** Run one tool call. Never throws: errors come back as { ok: false } so the engine can count them. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const executor = EXECUTORS[name];
  if (!executor) {
    return { ok: false, error: `Tool tidak dikenal: ${name}` };
  }
  try {
    return { ok: true, data: await executor(args, ctx) };
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof DomainError) {
      return { ok: false, error: error.message };
    }
    console.error(`[tool ${name}] unexpected error`, error);
    return { ok: false, error: 'Sistem lagi bermasalah.' };
  }
}
