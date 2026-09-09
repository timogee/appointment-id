import { db } from '@/db/client';
import { paymentRecord, service, staff } from '@/db/schema';
import { getBookingsForDate } from '@/domain/booking-service';
import { listHandoffs } from '@/chat/session';
import { jakartaDateKey, formatDateId, utcToJakartaTime } from '@/domain/time';
import { formatRupiah } from '@/domain/money';
import { BUSINESS, DP_AMOUNT_RUPIAH } from '@/config/business';
import { TRANSITIONS } from '@/domain/booking-states';
import { isAdmin } from './auth';
import {
  cancelAction,
  completeAction,
  confirmDpAction,
  loginAction,
  logoutAction,
  noShowAction,
  resolveHandoffAction,
} from './actions';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Nunggu DP',
  confirmed: 'Fix',
  cancelled: 'Batal',
  no_show: 'Nggak datang',
  completed: 'Selesai',
};

const STATUS_STYLE: Record<string, string> = {
  pending_payment: 'bg-amber-100 text-amber-900',
  confirmed: 'bg-emerald-100 text-emerald-900',
  cancelled: 'bg-neutral-200 text-neutral-600',
  no_show: 'bg-rose-100 text-rose-900',
  completed: 'bg-sky-100 text-sky-900',
};

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  if (!(await isAdmin())) return <Login />;

  const params = await searchParams;
  const date = params.date ?? jakartaDateKey(new Date());

  const [rows, handoffs, staffRows, serviceRows, payments] = await Promise.all([
    getBookingsForDate(date),
    listHandoffs(),
    db.select().from(staff),
    db.select().from(service),
    db.select().from(paymentRecord),
  ]);

  const staffName = new Map(staffRows.map((s) => [s.id, s.name]));
  const serviceName = new Map(serviceRows.map((s) => [s.id, s.name]));
  const paymentFor = new Map(payments.map((p) => [p.bookingId, p]));

  const revenue = rows
    .filter((r) => r.booking.status === 'completed')
    .reduce((sum, r) => sum + r.booking.priceRupiah, 0);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{BUSINESS.name}</h1>
          <p className="text-sm text-neutral-600">{formatDateId(date)}</p>
        </div>
        <form action={logoutAction}>
          <button className="text-sm text-neutral-500 underline">Keluar</button>
        </form>
      </header>

      <form className="mb-6 flex gap-2 text-sm">
        <input
          type="date"
          name="date"
          defaultValue={date}
          className="rounded border border-neutral-300 px-2 py-1"
        />
        <button className="rounded bg-neutral-900 px-3 py-1 text-white">Lihat</button>
      </form>

      {handoffs.length > 0 && (
        <section className="mb-6 rounded border border-rose-300 bg-rose-50 p-4">
          <h2 className="mb-2 font-medium text-rose-900">
            Chat yang perlu kamu balas sendiri ({handoffs.length})
          </h2>
          <ul className="space-y-2 text-sm">
            {handoffs.map((h) => (
              <li key={h.phone} className="flex items-center justify-between gap-3">
                <span>
                  <span className="font-mono">{h.phone}</span>
                  <span className="ml-2 text-rose-800">{h.handoffReason}</span>
                </span>
                <form action={resolveHandoffAction}>
                  <input type="hidden" name="phone" value={h.phone} />
                  <button className="rounded border border-rose-400 px-2 py-1 text-rose-900">
                    Udah ditangani
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        {rows.length === 0 && (
          <p className="rounded border border-dashed border-neutral-300 p-8 text-center text-neutral-500">
            Belum ada booking hari ini.
          </p>
        )}

        {rows.map(({ booking: b, customerPhone, customerName }) => {
          const allowed = TRANSITIONS[b.status];
          const payment = paymentFor.get(b.id);
          return (
            <article key={b.id} className="rounded border border-neutral-200 bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="text-lg font-medium">{utcToJakartaTime(b.startTime)}</span>
                  <span className="ml-3">{serviceName.get(b.serviceId)}</span>
                  <span className="ml-3 text-neutral-600">sama {staffName.get(b.staffId)}</span>
                </div>
                <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[b.status]}`}>
                  {STATUS_LABEL[b.status]}
                </span>
              </div>

              <p className="mt-1 text-sm text-neutral-600">
                {customerName ?? 'Tanpa nama'} · <span className="font-mono">{customerPhone}</span>{' '}
                · {formatRupiah(b.priceRupiah)} · {b.source}
              </p>

              {b.status === 'pending_payment' && (
                <p className="mt-1 text-sm text-amber-800">
                  Hold sampai {b.holdExpiresAt ? utcToJakartaTime(b.holdExpiresAt) : '-'} · DP{' '}
                  {formatRupiah(DP_AMOUNT_RUPIAH)}
                  {payment?.proofImageUrl ? ' · bukti transfer terkirim' : ' · belum ada bukti'}
                </p>
              )}

              {payment?.proofImageUrl && (
                <a
                  href={payment.proofImageUrl}
                  className="mt-1 inline-block text-sm text-sky-700 underline"
                >
                  Lihat bukti transfer
                </a>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                {allowed.includes('confirmed') && (
                  <form action={confirmDpAction} className="flex gap-1">
                    <input type="hidden" name="bookingId" value={b.id} />
                    <input
                      name="proofImageUrl"
                      placeholder="URL bukti (opsional)"
                      className="w-44 rounded border border-neutral-300 px-2 py-1 text-sm"
                    />
                    <button className="rounded bg-emerald-600 px-3 py-1 text-sm text-white">
                      DP diterima
                    </button>
                  </form>
                )}
                {allowed.includes('completed') && (
                  <Action
                    action={completeAction}
                    id={b.id}
                    label="Selesai"
                    className="bg-sky-600"
                  />
                )}
                {allowed.includes('no_show') && (
                  <Action
                    action={noShowAction}
                    id={b.id}
                    label="Nggak datang"
                    className="bg-rose-600"
                  />
                )}
                {allowed.includes('cancelled') && (
                  <Action
                    action={cancelAction}
                    id={b.id}
                    label="Batalkan"
                    className="bg-neutral-600"
                  />
                )}
                {allowed.length === 0 && (
                  <span className="text-sm text-neutral-400">Sudah final.</span>
                )}
              </div>
            </article>
          );
        })}
      </section>

      <p className="mt-6 text-sm text-neutral-600">Selesai hari ini: {formatRupiah(revenue)}</p>
    </main>
  );
}

function Action({
  action,
  id,
  label,
  className,
}: {
  action: (formData: FormData) => Promise<void>;
  id: string;
  label: string;
  className: string;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="bookingId" value={id} />
      <button className={`rounded px-3 py-1 text-sm text-white ${className}`}>{label}</button>
    </form>
  );
}

function Login() {
  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="mb-4 text-xl font-semibold">Masuk admin</h1>
      <form action={loginAction} className="space-y-2">
        <input
          type="password"
          name="password"
          placeholder="Password"
          className="w-full rounded border border-neutral-300 px-3 py-2"
        />
        <button className="w-full rounded bg-neutral-900 px-3 py-2 text-white">Masuk</button>
      </form>
    </main>
  );
}
