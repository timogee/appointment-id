/**
 * Every business fact lives here. One business, one timezone, owner-managed.
 * Changing the client means editing this file and re-running the seed.
 */

export const BUSINESS = {
  name: 'Barberkuy Kemang',
  shortName: 'Barberkuy',
  address: 'Jl. Kemang Raya No. 42, Jakarta Selatan',
  phone: '6285117123469',
  timezone: 'Asia/Jakarta',
  locale: 'id-ID',
} as const;

/** Minutes a pending_payment booking holds its slot before the expiry job releases it. */
export const HOLD_MINUTES = 60;

/** Granularity of offered start times, in minutes. */
export const SLOT_STEP_MINUTES = 15;

/** Gap kept after every booking. Stored per-service; this is the default. */
export const DEFAULT_BUFFER_MINUTES = 10;

/** Flat DP in integer rupiah. Per-service DP is a later change, not a rewrite. */
export const DP_AMOUNT_RUPIAH = 50_000;

/** How far ahead the bot will look when asked for alternatives. */
export const ALTERNATIVE_SEARCH_DAYS = 7;

/** Where the customer sends the DP. Manual transfer is the real product here. */
export const PAYMENT_DETAILS = {
  bankName: 'BCA',
  accountNumber: '6265122781',
  accountHolder: 'Barberkuy Kemang',
  qrisImagePath: '/qris.png',
} as const;

/** day_of_week uses JS getDay(): 0=Minggu .. 6=Sabtu. Senin (1) is absent = libur. */
export const OPENING_HOURS: ReadonlyArray<{
  dayOfWeek: number;
  open: string;
  close: string;
}> = [
  { dayOfWeek: 2, open: '10:00', close: '20:00' }, // Selasa
  { dayOfWeek: 3, open: '10:00', close: '20:00' }, // Rabu
  { dayOfWeek: 4, open: '10:00', close: '20:00' }, // Kamis
  { dayOfWeek: 5, open: '10:00', close: '20:00' }, // Jumat
  { dayOfWeek: 6, open: '09:00', close: '21:00' }, // Sabtu
  { dayOfWeek: 0, open: '09:00', close: '21:00' }, // Minggu
];

export const SEED_STAFF = ['Clara', 'Carla', 'Karyn'] as const;

export const SEED_SERVICES: ReadonlyArray<{
  name: string;
  durationMinutes: number;
  priceRupiah: number;
  /** Staff who can perform it. Karyn does not do Cat Rambut. */
  staff: ReadonlyArray<(typeof SEED_STAFF)[number]>;
}> = [
  {
    name: 'Potong Rambut Pria',
    durationMinutes: 45,
    priceRupiah: 65_000,
    staff: ['Clara', 'Carla', 'Karyn'],
  },
  {
    name: 'Potong + Keramas',
    durationMinutes: 60,
    priceRupiah: 90_000,
    staff: ['Clara', 'Carla', 'Karyn'],
  },
  {
    name: 'Cukur Jenggot',
    durationMinutes: 30,
    priceRupiah: 45_000,
    staff: ['Clara', 'Carla', 'Karyn'],
  },
  {
    name: 'Potong Anak',
    durationMinutes: 30,
    priceRupiah: 50_000,
    staff: ['Clara', 'Carla', 'Karyn'],
  },
  { name: 'Cat Rambut', durationMinutes: 90, priceRupiah: 250_000, staff: ['Clara', 'Carla'] },
];
