/**
 * The ONLY place UTC instants and Asia/Jakarta wall-clock are converted.
 *
 * Rule: instants are stored and passed around as UTC `Date`s. Wall-clock strings
 * ('2026-09-10', '14:30') are Jakarta-local and exist only at the edges — the
 * working_hours table, the date parser, and display.
 *
 * WIB is a fixed UTC+7 with no DST, but the conversion goes through Intl anyway
 * so this file stays correct rather than merely lucky.
 */
import { BUSINESS } from '@/config/business';

const TZ = BUSINESS.timezone;

export type JakartaDate = string; // 'YYYY-MM-DD'
export type WallClock = string; // 'HH:mm' or 'HH:mm:ss'

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function partsOf(instant: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of partsFormatter.formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset of Asia/Jakarta from UTC, in minutes, at the given instant. */
function offsetMinutesAt(instant: Date): number {
  const p = partsOf(instant);
  const asUtc = Date.UTC(
    p.year!,
    p.month! - 1,
    p.day!,
    p.hour! === 24 ? 0 : p.hour!,
    p.minute!,
    p.second!,
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/** '2026-09-10' in Jakarta for the given instant. */
export function jakartaDateKey(instant: Date): JakartaDate {
  const p = partsOf(instant);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 0=Minggu .. 6=Sabtu, for a Jakarta calendar date. */
export function jakartaDayOfWeek(date: JakartaDate): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/**
 * Jakarta wall-clock -> UTC instant. Two-pass so it stays correct under any
 * hypothetical offset change.
 */
export function jakartaToUtc(date: JakartaDate, time: WallClock): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  const naive = Date.UTC(y!, m! - 1, d!, hh!, mm ?? 0, ss ?? 0);
  let guess = new Date(naive - 7 * 60 * 60_000);
  guess = new Date(naive - offsetMinutesAt(guess) * 60_000);
  return guess;
}

/** UTC instant -> Jakarta 'HH:mm'. */
export function utcToJakartaTime(instant: Date): WallClock {
  const p = partsOf(instant);
  return `${String(p.hour === 24 ? 0 : p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}

/** Jakarta calendar-day boundaries as UTC instants. A Jakarta day starts at 17:00 UTC the day before. */
export function jakartaDayBounds(date: JakartaDate): { start: Date; end: Date } {
  return { start: jakartaToUtc(date, '00:00'), end: jakartaToUtc(nextDate(date), '00:00') };
}

export function nextDate(date: JakartaDate, days = 1): JakartaDate {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'] as const;
const MONTH_NAMES = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
] as const;

export function dayNameId(date: JakartaDate): string {
  return DAY_NAMES[jakartaDayOfWeek(date)]!;
}

/** 'Kamis, 10 September' — how the bot names a day to a customer. */
export function formatDateId(date: JakartaDate): string {
  const [, m, d] = date.split('-').map(Number);
  return `${dayNameId(date)}, ${d} ${MONTH_NAMES[m! - 1]}`;
}

/** 'Kamis, 10 September 14:30' */
export function formatInstantId(instant: Date): string {
  return `${formatDateId(jakartaDateKey(instant))} ${utcToJakartaTime(instant)}`;
}
