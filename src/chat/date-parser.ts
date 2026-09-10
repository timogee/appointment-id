/**
 * Indonesian relative-date resolution. DETERMINISTIC, in application code.
 *
 * The LLM never does this. "besok sore" becoming the wrong Saturday is a bug
 * with a stack trace, not a prompt to tune. Everything here is anchored to
 * Asia/Jakarta via src/domain/time.ts.
 */
import { jakartaDateKey, jakartaDayOfWeek, nextDate, type JakartaDate } from '@/domain/time';

export interface TimeOfDayWindow {
  label: 'pagi' | 'siang' | 'sore' | 'malam';
  /** Jakarta wall-clock, inclusive start, exclusive end. */
  fromTime: string;
  toTime: string;
}

export interface ParsedDate {
  /** One or more Jakarta calendar dates the customer might mean. */
  dates: JakartaDate[];
  /** Present when the message narrowed the time of day. */
  timeOfDay?: TimeOfDayWindow;
  /** Present when the message named an explicit clock time, e.g. "jam 2". */
  explicitTime?: string;
  /** What the parser matched on. Useful in transcripts and debugging. */
  matched: string[];
}

const TIME_OF_DAY: Record<string, TimeOfDayWindow> = {
  pagi: { label: 'pagi', fromTime: '06:00', toTime: '11:00' },
  siang: { label: 'siang', fromTime: '11:00', toTime: '15:00' },
  sore: { label: 'sore', fromTime: '15:00', toTime: '18:30' },
  malam: { label: 'malam', fromTime: '18:30', toTime: '23:00' },
};

/** 0=Minggu .. 6=Sabtu, matching jakartaDayOfWeek. */
const WEEKDAYS: Record<string, number> = {
  minggu: 0,
  ahad: 0,
  senin: 1,
  selasa: 2,
  rabu: 3,
  kamis: 4,
  jumat: 5,
  jumaat: 5,
  "jum'at": 5,
  sabtu: 6,
  sabtuan: 6,
};

const MONTHS: Record<string, number> = {
  januari: 1,
  februari: 2,
  maret: 3,
  april: 4,
  mei: 5,
  juni: 6,
  juli: 7,
  agustus: 8,
  september: 9,
  oktober: 10,
  november: 11,
  desember: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  agu: 8,
  sep: 9,
  okt: 10,
  nov: 11,
  des: 12,
};

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s:'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Next occurrence of a weekday strictly after `from`, or today if it matches and allowToday. */
function nextWeekday(from: JakartaDate, target: number, allowToday: boolean): JakartaDate {
  for (let i = allowToday ? 0 : 1; i <= 7; i += 1) {
    const candidate = nextDate(from, i);
    if (jakartaDayOfWeek(candidate) === target) return candidate;
  }
  return from;
}

/**
 * Parse a customer message into candidate Jakarta dates.
 * Returns null when the message names no date at all — the caller then asks,
 * rather than the model inventing one.
 */
export function parseIndonesianDate(text: string, now: Date): ParsedDate | null {
  const t = normalise(text);
  const today = jakartaDateKey(now);
  const matched: string[] = [];
  let dates: JakartaDate[] | null = null;

  // --- time of day
  let timeOfDay: TimeOfDayWindow | undefined;
  for (const [word, window] of Object.entries(TIME_OF_DAY)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) {
      timeOfDay = window;
      matched.push(word);
      break;
    }
  }

  // --- explicit clock time: "jam 2", "jam 14", "jam 2 siang", "14:30", "jam setengah 3"
  let explicitTime: string | undefined;
  const clock = t.match(/\b(?:jam\s*)?(\d{1,2})[.:](\d{2})\b/) ?? t.match(/\bjam\s*(\d{1,2})\b/);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    // "jam 2 sore" means 14:00. Without a qualifier, small hours stay as written.
    if (hour < 12 && timeOfDay && (timeOfDay.label === 'sore' || timeOfDay.label === 'malam')) {
      hour += 12;
    }
    if (hour < 12 && timeOfDay?.label === 'siang' && hour < 11) hour += 12;
    if (hour <= 23) {
      explicitTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      matched.push(clock[0].trim());
    }
  }

  // --- explicit calendar date: "tgl 12", "12 september"
  const dm = t.match(
    /\b(\d{1,2})\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|agu|sep|okt|nov|des)\b/,
  );
  if (dm) {
    const day = Number(dm[1]);
    const month = MONTHS[dm[2]!]!;
    const year = Number(today.slice(0, 4));
    const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // A date already past this year means they mean next year.
    dates = [candidate < today ? `${year + 1}-${candidate.slice(5)}` : candidate];
    matched.push(dm[0]);
  }

  if (!dates) {
    const tgl = t.match(/\b(?:tgl|tanggal)\s*(\d{1,2})\b/);
    if (tgl) {
      const day = Number(tgl[1]);
      const [y, m] = today.split('-').map(Number);
      const thisMonth = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      // "tgl 5" when today is the 20th means next month.
      dates = [thisMonth < today ? addMonth(thisMonth) : thisMonth];
      matched.push(tgl[0]);
    }
  }

  // --- relative words
  if (!dates) {
    if (/\b(hari ini|skrg|sekarang|nanti)\b/.test(t)) {
      dates = [today];
      matched.push('hari ini');
    } else if (/\blusa\b/.test(t)) {
      dates = [nextDate(today, 2)];
      matched.push('lusa');
    } else if (/\b(besok|bsk|bsok)\b/.test(t)) {
      dates = [nextDate(today, 1)];
      matched.push('besok');
    }
  }

  // --- "minggu depan" / "pekan depan" means NEXT WEEK, not next Sunday, unless the
  //     customer wrote "hari minggu". This must be decided before the weekday loop
  //     below, because 'minggu' is also the name of a day.
  if (!dates && /\b(minggu|pekan)\s+(depan|dpn)\b/.test(t) && !/\bhari\s+minggu\b/.test(t)) {
    const start = nextWeekday(today, 1, false); // the coming Senin
    dates = Array.from({ length: 7 }, (_, i) => nextDate(start, i));
    matched.push('minggu depan');
  }

  // --- weekday names, with "depan" pushing a week out
  if (!dates) {
    for (const [word, dow] of Object.entries(WEEKDAYS)) {
      if (!new RegExp(`\\b${word}\\b`).test(t)) continue;
      const isNextWeek = new RegExp(`\\b${word}\\s+(depan|dpn)\\b`).test(t);
      // Bare "sabtu" means the coming Saturday, today included only if it IS Saturday
      // and they said "sabtu ini".
      const allowToday = new RegExp(`\\b${word}\\s+ini\\b`).test(t);
      let date = nextWeekday(today, dow, allowToday);
      if (isNextWeek) date = nextDate(date, 7);
      dates = [date];
      matched.push(isNextWeek ? `${word} depan` : word);
      break;
    }
  }

  // --- weekend
  if (!dates && /\b(weekend|akhir pekan)\b/.test(t)) {
    dates = [nextWeekday(today, 6, true), nextWeekday(today, 0, true)].sort();
    matched.push('weekend');
  }

  if (!dates && !timeOfDay && !explicitTime) return null;

  // A bare "sore" with no day means today if it is still early enough, else tomorrow.
  if (!dates) {
    dates = [today];
    matched.push('hari ini (implisit)');
  }

  return {
    dates,
    ...(timeOfDay ? { timeOfDay } : {}),
    ...(explicitTime ? { explicitTime } : {}),
    matched,
  };
}

function addMonth(date: JakartaDate): JakartaDate {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m!, d!)); // m is 0-indexed next month
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export { TIME_OF_DAY };
