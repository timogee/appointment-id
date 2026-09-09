import { BUSINESS, OPENING_HOURS } from '@/config/business';
import { formatRupiah } from '@/domain/money';
import { jakartaDateKey } from '@/domain/time';
import { loadOptions } from './actions';
import { BookingForm } from './booking-form';

export const dynamic = 'force-dynamic';

const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

export default async function HomePage() {
  const { services } = await loadOptions();
  const today = jakartaDateKey(new Date());

  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="text-2xl font-semibold">{BUSINESS.name}</h1>
      <p className="mt-1 text-sm text-neutral-600">{BUSINESS.address}</p>

      <p className="mt-4 rounded bg-emerald-50 p-3 text-sm text-emerald-900">
        Paling gampang booking lewat WhatsApp ke <span className="font-mono">{BUSINESS.phone}</span>
        . Form di bawah buat yang lebih suka klik-klik.
      </p>

      <BookingForm
        services={services.map((s) => ({
          id: s.id,
          name: s.name,
          durationMinutes: s.durationMinutes,
          priceLabel: formatRupiah(s.priceRupiah),
        }))}
        today={today}
      />

      <section className="mt-8 text-sm text-neutral-600">
        <h2 className="mb-1 font-medium text-neutral-900">Jam buka</h2>
        <ul>
          {[0, 1, 2, 3, 4, 5, 6].map((d) => {
            const hours = OPENING_HOURS.find((h) => h.dayOfWeek === d);
            return (
              <li key={d}>
                {DAY_NAMES[d]}: {hours ? `${hours.open}–${hours.close}` : 'Libur'}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
