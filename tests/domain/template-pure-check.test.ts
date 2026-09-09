/**
 * TEMPLATE VERIFICATION (pure shape) — the exact file documented in
 * .claude/skills/testing/SKILL.md. It runs so the documented template is known
 * to compile and pass, not merely to look plausible.
 */
import { describe, expect, it } from 'vitest';
import { getAvailableSlots } from '../../src/domain/availability';
import { jakartaToUtc, utcToJakartaTime } from '../../src/domain/time';

/** Slot starts as Jakarta 'HH:mm' — how a human checks this against shop hours. */
const times = (slots: Array<{ start: Date }>) => slots.map((s) => utcToJakartaTime(s.start));
const at = (date: string, time: string) => jakartaToUtc(date, time);

describe('getAvailableSlots', () => {
  it('does not offer a slot that would overlap an existing booking', () => {
    const slots = getAvailableSlots({
      workingWindows: [{ start: at('2026-09-10', '10:00'), end: at('2026-09-10', '12:00') }],
      busy: [{ start: at('2026-09-10', '10:00'), end: at('2026-09-10', '10:55') }],
      durationMinutes: 45,
      bufferMinutes: 10,
    });

    expect(times(slots)).not.toContain('10:00');
    expect(times(slots)).toContain('11:00');
  });
});
