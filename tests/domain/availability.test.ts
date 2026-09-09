/**
 * The availability engine. Pure arithmetic — no database, no clock.
 *
 * Times in these tests are written as Jakarta wall-clock via jakartaToUtc so a
 * reader can check them against the shop's real hours without doing UTC maths
 * in their head.
 */
import { describe, expect, it } from 'vitest';
import {
  getAvailableSlots,
  suggestAlternatives,
  type Interval,
} from '../../src/domain/availability';
import { jakartaToUtc, utcToJakartaTime, jakartaDateKey } from '../../src/domain/time';

const KAMIS = '2026-09-10'; // Kamis: buka 10:00-20:00
const SENIN = '2026-09-14'; // Senin: libur
const SABTU = '2026-09-12'; // Sabtu: buka 09:00-21:00

const at = (date: string, time: string) => jakartaToUtc(date, time);
const window = (date: string, open: string, close: string): Interval => ({
  start: at(date, open),
  end: at(date, close),
});

/** Slot start times as Jakarta 'HH:mm', which is how a human checks this. */
const times = (slots: Array<{ start: Date }>) => slots.map((s) => utcToJakartaTime(s.start));

const POTONG = { durationMinutes: 45, bufferMinutes: 10 };

describe('getAvailableSlots', () => {
  it('returns nothing when the staff member has no working hours that day', () => {
    const slots = getAvailableSlots({ workingWindows: [], busy: [], ...POTONG });
    expect(slots).toEqual([]);
  });

  it('returns nothing on a closed day (Senin libur)', () => {
    // The loader produces no windows for Senin because working_hours has no row
    // for day_of_week = 1. The engine simply sees an empty list.
    const slots = getAvailableSlots({ workingWindows: [], busy: [], ...POTONG });
    expect(slots).toEqual([]);
    expect(jakartaDateKey(at(SENIN, '12:00'))).toBe(SENIN);
  });

  it('offers slots on the step grid from opening time', () => {
    const slots = getAvailableSlots({
      workingWindows: [window(KAMIS, '10:00', '12:00')],
      busy: [],
      ...POTONG,
    });
    expect(times(slots)).toEqual(['10:00', '10:15', '10:30', '10:45', '11:00', '11:15']);
  });

  it('skips slots covered by time off mid-day', () => {
    const slots = getAvailableSlots({
      workingWindows: [window(KAMIS, '10:00', '13:00')],
      busy: [{ start: at(KAMIS, '11:00'), end: at(KAMIS, '12:00') }],
      ...POTONG,
    });
    // 10:15 would occupy 10:15-11:10 and clash with the 11:00 block.
    expect(times(slots)).toEqual(['10:00', '12:00', '12:15']);
  });

  it('allows a back-to-back booking exactly when the previous one is done', () => {
    // A booking occupying 10:00-10:55 (45 + 10 buffer) frees 10:55 onward.
    const slots = getAvailableSlots({
      workingWindows: [window(KAMIS, '10:00', '12:00')],
      busy: [{ start: at(KAMIS, '10:00'), end: at(KAMIS, '10:55') }],
      ...POTONG,
      stepMinutes: 5,
    });
    expect(times(slots)[0]).toBe('10:55');
  });

  it('does not offer a service longer than the window left before closing', () => {
    // Cat Rambut is 90 minutes. A window closing at 20:00 cannot start one at 18:45.
    const slots = getAvailableSlots({
      workingWindows: [window(KAMIS, '18:00', '20:00')],
      busy: [],
      durationMinutes: 90,
      bufferMinutes: 10,
    });
    expect(times(slots)).toEqual(['18:00', '18:15', '18:30']);
    // 18:30 + 90 = 20:00 exactly, which fits. 18:45 would end at 20:15, which does not.
    expect(times(slots)).not.toContain('18:45');
  });

  it('offers a slot that a cancelled booking used to occupy', () => {
    // A cancelled booking never reaches the engine: loadBusy filters on
    // SLOT_HOLDING_STATUSES. Absence from `busy` IS the freeing.
    const withBooking = getAvailableSlots({
      workingWindows: [window(KAMIS, '10:00', '11:30')],
      busy: [{ start: at(KAMIS, '10:00'), end: at(KAMIS, '10:55') }],
      ...POTONG,
    });
    const afterCancel = getAvailableSlots({
      workingWindows: [window(KAMIS, '10:00', '11:30')],
      busy: [],
      ...POTONG,
    });
    expect(times(withBooking)).not.toContain('10:00');
    expect(times(afterCancel)).toContain('10:00');
  });

  it('treats a pending_payment booking as blocking', () => {
    // pending_payment is in SLOT_HOLDING_STATUSES, so the loader includes it in
    // `busy` exactly like a confirmed booking. An unpaid hold really holds.
    const slots = getAvailableSlots({
      workingWindows: [window(KAMIS, '10:00', '12:00')],
      busy: [{ start: at(KAMIS, '10:00'), end: at(KAMIS, '10:55') }],
      ...POTONG,
    });
    expect(times(slots)).not.toContain('10:00');
    expect(times(slots)).not.toContain('10:30');
    expect(times(slots)).toContain('11:00');
  });

  it('handles a slot spanning local midnight without leaking into the wrong day', () => {
    // Jakarta is UTC+7, so a Jakarta day starts at 17:00 UTC the day before.
    // A window ending at 23:59 on Sabtu must stay on Sabtu in Jakarta terms.
    const slots = getAvailableSlots({
      workingWindows: [window(SABTU, '23:00', '23:59')],
      busy: [],
      durationMinutes: 30,
      bufferMinutes: 30,
      stepMinutes: 15,
    });
    expect(times(slots)).toEqual(['23:00', '23:15']);
    for (const slot of slots) {
      expect(jakartaDateKey(slot.start)).toBe(SABTU);
    }
    // The trailing buffer runs into the next Jakarta day. The START does not, and
    // that is what decides which day the slot belongs to.
    const last = slots[1]!;
    expect(last.occupiedEnd.toISOString()).toBe(at('2026-09-13', '00:15').toISOString());
    expect(jakartaDateKey(last.occupiedEnd)).toBe('2026-09-13');
    expect(jakartaDateKey(last.start)).toBe(SABTU);
  });

  it('honours notBefore so past slots are never offered', () => {
    const slots = getAvailableSlots({
      workingWindows: [window(KAMIS, '10:00', '12:00')],
      busy: [],
      ...POTONG,
      notBefore: at(KAMIS, '11:00'),
    });
    expect(times(slots)).toEqual(['11:00', '11:15']);
  });
});

describe('suggestAlternatives', () => {
  const maria = {
    staffId: 'maria',
    staffName: 'Maria',
    workingWindows: [window(KAMIS, '10:00', '12:00')],
    busy: [{ start: at(KAMIS, '10:00'), end: at(KAMIS, '10:55') }],
    ...POTONG,
  };
  const clara = {
    staffId: 'clara',
    staffName: 'Clara',
    workingWindows: [window(KAMIS, '10:00', '12:00')],
    busy: [],
    ...POTONG,
  };

  it('offers other times with the requested staff member', () => {
    const alt = suggestAlternatives({
      perStaff: [maria, clara],
      preferredStaffId: 'maria',
      wantedStart: at(KAMIS, '10:00'),
    });
    expect(alt.sameStaffOtherTimes.every((e) => e.staffName === 'Maria')).toBe(true);
    expect(times(alt.sameStaffOtherTimes.map((e) => e.slot))).toContain('11:00');
  });

  it('offers the same time with a different qualified staff member', () => {
    const alt = suggestAlternatives({
      perStaff: [maria, clara],
      preferredStaffId: 'maria',
      wantedStart: at(KAMIS, '10:00'),
    });
    expect(alt.sameTimeOtherStaff).toHaveLength(1);
    expect(alt.sameTimeOtherStaff[0]!.staffName).toBe('Clara');
    expect(utcToJakartaTime(alt.sameTimeOtherStaff[0]!.slot.start)).toBe('10:00');
  });

  it('never re-offers the exact time the customer could not get', () => {
    const alt = suggestAlternatives({
      perStaff: [clara],
      preferredStaffId: 'clara',
      wantedStart: at(KAMIS, '10:00'),
    });
    expect(times(alt.sameStaffOtherTimes.map((e) => e.slot))).not.toContain('10:00');
  });

  it('returns no same-time option when nobody else is free then', () => {
    const busyClara = { ...clara, busy: [{ start: at(KAMIS, '10:00'), end: at(KAMIS, '10:55') }] };
    const alt = suggestAlternatives({
      perStaff: [maria, busyClara],
      preferredStaffId: 'maria',
      wantedStart: at(KAMIS, '10:00'),
    });
    expect(alt.sameTimeOtherStaff).toEqual([]);
    expect(alt.sameStaffOtherTimes.length).toBeGreaterThan(0);
  });
});
