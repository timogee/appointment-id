'use client';

import { useState, useTransition } from 'react';
import { bookAction, loadSlots, type BookResult } from './actions';

interface ServiceOption {
  id: string;
  name: string;
  durationMinutes: number;
  priceLabel: string;
}

interface StaffSlots {
  staffId: string;
  staffName: string;
  closed: boolean;
  slots: Array<{ startIso: string; time: string }>;
}

/**
 * Fallback booking flow: service -> date -> a real computed slot -> details.
 * Slots come from the same engine the chat bot uses; nothing is precomputed.
 */
export function BookingForm({ services, today }: { services: ServiceOption[]; today: string }) {
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(today);
  const [staffSlots, setStaffSlots] = useState<StaffSlots[] | null>(null);
  const [picked, setPicked] = useState<{
    staffId: string;
    staffName: string;
    startIso: string;
    time: string;
  } | null>(null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [result, setResult] = useState<BookResult | null>(null);
  const [pending, start] = useTransition();

  function check(nextService = serviceId, nextDate = date) {
    if (!nextService) return;
    setPicked(null);
    setResult(null);
    start(async () => setStaffSlots(await loadSlots(nextService, nextDate)));
  }

  const anyOpen = staffSlots?.some((s) => s.slots.length > 0) ?? false;

  if (result?.ok) {
    return (
      <div className="mt-6 rounded border border-emerald-300 bg-emerald-50 p-4">
        <h2 className="font-medium text-emerald-900">Slot kamu udah dikunci</h2>
        <pre className="mt-2 whitespace-pre-wrap text-sm text-emerald-900">
          {result.instructions}
        </pre>
        <p className="mt-2 text-sm text-emerald-800">
          Slot ini kami tahan 60 menit. Kalau DP belum masuk, otomatis dilepas lagi ya.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Mau layanan apa?</span>
        <select
          value={serviceId}
          onChange={(e) => {
            setServiceId(e.target.value);
            check(e.target.value, date);
          }}
          className="mt-1 w-full rounded border border-neutral-300 px-3 py-2"
        >
          <option value="">— pilih —</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.durationMinutes} menit · {s.priceLabel}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm font-medium">Kapan?</span>
        <input
          type="date"
          value={date}
          min={today}
          onChange={(e) => {
            setDate(e.target.value);
            check(serviceId, e.target.value);
          }}
          className="mt-1 w-full rounded border border-neutral-300 px-3 py-2"
        />
      </label>

      {pending && <p className="text-sm text-neutral-500">Ngecek jam kosong…</p>}

      {staffSlots && !pending && !anyOpen && (
        <p className="rounded bg-amber-50 p-3 text-sm text-amber-900">
          Nggak ada jam kosong di tanggal itu. Coba tanggal lain, atau chat WhatsApp — nanti
          dicarikan alternatifnya.
        </p>
      )}

      {staffSlots?.map((s) => (
        <div key={s.staffId}>
          <p className="text-sm font-medium">
            {s.staffName}
            {s.closed && <span className="ml-2 text-neutral-500">libur</span>}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {s.slots.map((slot) => (
              <button
                key={slot.startIso}
                onClick={() => setPicked({ staffId: s.staffId, staffName: s.staffName, ...slot })}
                className={`rounded border px-2 py-1 text-sm ${
                  picked?.startIso === slot.startIso && picked.staffId === s.staffId
                    ? 'border-neutral-900 bg-neutral-900 text-white'
                    : 'border-neutral-300 bg-white'
                }`}
              >
                {slot.time}
              </button>
            ))}
            {!s.closed && s.slots.length === 0 && (
              <span className="text-sm text-neutral-500">penuh</span>
            )}
          </div>
        </div>
      ))}

      {picked && (
        <div className="space-y-2 rounded border border-neutral-300 bg-white p-4">
          <p className="text-sm">
            {picked.time} sama <strong>{picked.staffName}</strong>
          </p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nama kamu"
            className="w-full rounded border border-neutral-300 px-3 py-2"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Nomor WhatsApp, cth 08123456789"
            inputMode="numeric"
            className="w-full rounded border border-neutral-300 px-3 py-2"
          />
          {result && !result.ok && <p className="text-sm text-rose-700">{result.error}</p>}
          <button
            disabled={pending || !phone}
            onClick={() =>
              start(async () => {
                const r = await bookAction({
                  serviceId,
                  staffId: picked.staffId,
                  startIso: picked.startIso,
                  phone,
                  name,
                });
                setResult(r);
                // Someone else may have taken it while this form was open.
                if (!r.ok) check();
              })
            }
            className="w-full rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-40"
          >
            Kunci slot ini
          </button>
        </div>
      )}
    </div>
  );
}
