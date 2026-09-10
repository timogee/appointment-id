/**
 * The Indonesian date parser, pinned against Asia/Jakarta with a frozen clock.
 *
 * This is tested separately from the chat layer on purpose: if "besok sore"
 * resolves wrongly the customer shows up on the wrong day, and that must be
 * caught here rather than in a transcript test where an LLM could mask it.
 */
import { describe, expect, it } from 'vitest';
import { parseIndonesianDate } from '../../src/chat/date-parser';
import { jakartaDateKey, jakartaDayOfWeek } from '../../src/domain/time';

/** Rabu 9 September 2026, 14:00 WIB (07:00 UTC). */
const NOW = new Date('2026-09-09T07:00:00Z');

/** Rabu 9 September 2026, 23:30 WIB — 16:30 UTC, i.e. still the 9th in Jakarta. */
const LATE = new Date('2026-09-09T16:30:00Z');

describe('anchoring', () => {
  it('treats a late-evening UTC instant as the correct Jakarta day', () => {
    expect(jakartaDateKey(NOW)).toBe('2026-09-09');
    expect(jakartaDateKey(LATE)).toBe('2026-09-09');
    expect(jakartaDayOfWeek('2026-09-09')).toBe(3); // Rabu
  });
});

describe('relative days', () => {
  it('resolves besok', () => {
    expect(parseIndonesianDate('besok bisa ga', NOW)?.dates).toEqual(['2026-09-10']);
  });

  it('resolves besok correctly late at night, when UTC has already rolled over', () => {
    // 16:30 UTC is the next UTC day but still Rabu in Jakarta, so besok is Kamis.
    expect(parseIndonesianDate('besok ya', LATE)?.dates).toEqual(['2026-09-10']);
  });

  it('resolves lusa', () => {
    expect(parseIndonesianDate('lusa aja deh', NOW)?.dates).toEqual(['2026-09-11']);
  });

  it('resolves hari ini', () => {
    expect(parseIndonesianDate('hari ini masih bisa?', NOW)?.dates).toEqual(['2026-09-09']);
  });

  it('accepts the common shorthand bsk', () => {
    expect(parseIndonesianDate('bsk sore bisa?', NOW)?.dates).toEqual(['2026-09-10']);
  });
});

describe('weekday names', () => {
  it('resolves a bare weekday to the next occurrence', () => {
    // Today is Rabu; sabtu is the 12th.
    expect(parseIndonesianDate('sabtu bisa?', NOW)?.dates).toEqual(['2026-09-12']);
  });

  it('resolves "sabtu depan" to a week after that', () => {
    expect(parseIndonesianDate('sabtu depan aja', NOW)?.dates).toEqual(['2026-09-19']);
  });

  it('does not resolve a weekday to today unless the customer says "ini"', () => {
    const rabu = parseIndonesianDate('rabu bisa?', NOW);
    expect(rabu?.dates).toEqual(['2026-09-16']); // next Rabu, not today
    expect(parseIndonesianDate('rabu ini bisa?', NOW)?.dates).toEqual(['2026-09-09']);
  });

  it('resolves senin even though the shop is closed then (closure is not the parser’s job)', () => {
    expect(parseIndonesianDate('senin ya', NOW)?.dates).toEqual(['2026-09-14']);
  });
});

describe('time of day', () => {
  it('maps sore to an afternoon window', () => {
    const parsed = parseIndonesianDate('besok sore bisa?', NOW);
    expect(parsed?.dates).toEqual(['2026-09-10']);
    expect(parsed?.timeOfDay?.label).toBe('sore');
    expect(parsed?.timeOfDay?.fromTime).toBe('15:00');
  });

  it('maps pagi, siang and malam', () => {
    expect(parseIndonesianDate('besok pagi', NOW)?.timeOfDay?.label).toBe('pagi');
    expect(parseIndonesianDate('besok siang', NOW)?.timeOfDay?.label).toBe('siang');
    expect(parseIndonesianDate('besok malam', NOW)?.timeOfDay?.label).toBe('malam');
  });

  it('defaults a bare time-of-day to today', () => {
    const parsed = parseIndonesianDate('sore bisa ga', NOW);
    expect(parsed?.dates).toEqual(['2026-09-09']);
    expect(parsed?.timeOfDay?.label).toBe('sore');
  });
});

describe('explicit clock times', () => {
  it('reads "jam 2 sore" as 14:00', () => {
    expect(parseIndonesianDate('besok jam 2 sore', NOW)?.explicitTime).toBe('14:00');
  });

  it('reads "jam 10 pagi" as 10:00', () => {
    expect(parseIndonesianDate('besok jam 10 pagi', NOW)?.explicitTime).toBe('10:00');
  });

  it('reads a 24-hour time as written', () => {
    expect(parseIndonesianDate('besok 19:30', NOW)?.explicitTime).toBe('19:30');
  });
});

describe('explicit calendar dates', () => {
  it('reads "tgl 12"', () => {
    expect(parseIndonesianDate('tgl 12 bisa?', NOW)?.dates).toEqual(['2026-09-12']);
  });

  it('rolls "tgl 5" to next month when the 5th has passed', () => {
    expect(parseIndonesianDate('tgl 5 aja', NOW)?.dates).toEqual(['2026-10-05']);
  });

  it('reads "12 september"', () => {
    expect(parseIndonesianDate('12 september bisa?', NOW)?.dates).toEqual(['2026-09-12']);
  });
});

describe('ranges', () => {
  it('expands "minggu depan" to seven days starting Senin', () => {
    const parsed = parseIndonesianDate('minggu depan aja', NOW);
    expect(parsed?.dates[0]).toBe('2026-09-14'); // Senin
    expect(parsed?.dates).toHaveLength(7);
  });

  it('expands weekend to Sabtu and Minggu', () => {
    expect(parseIndonesianDate('weekend bisa?', NOW)?.dates).toEqual(['2026-09-12', '2026-09-13']);
  });
});

describe('no date at all', () => {
  it('returns null rather than guessing', () => {
    // The engine must then ask. It must NOT let the model invent a day.
    expect(parseIndonesianDate('berapaan sih potong sama clara', NOW)).toBeNull();
    expect(parseIndonesianDate('min ada tempat ga', NOW)).toBeNull();
  });
});

describe('the minggu ambiguity', () => {
  // 'minggu' is both "Sunday" and "week". Indonesians say "minggu depan" for
  // next week and "hari minggu depan" for next Sunday.
  it('reads "minggu depan" as next week', () => {
    expect(parseIndonesianDate('minggu depan aja', NOW)?.dates).toHaveLength(7);
  });

  it('reads "hari minggu depan" as a single Sunday', () => {
    expect(parseIndonesianDate('hari minggu depan bisa?', NOW)?.dates).toEqual(['2026-09-20']);
  });
});
