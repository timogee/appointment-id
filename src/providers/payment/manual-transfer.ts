import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { paymentRecord } from '@/db/schema';
import { BUSINESS, PAYMENT_DETAILS } from '@/config/business';
import { formatRupiah } from '@/domain/money';
import type { DpRequest, PaymentProvider, PaymentStatusValue } from './types';

/**
 * Returns the business's own account details and the exact amount. Status only
 * ever changes because the owner pressed "DP diterima" in the admin — see
 * confirmDpReceived in src/domain/booking-service.ts. Nothing here verifies a
 * payment; the system gathers evidence and the human decides.
 */
export class ManualTransferProvider implements PaymentProvider {
  async createDpRequest(bookingId: string, amountRupiah: number): Promise<DpRequest> {
    const reference = `DP-${bookingId.slice(0, 8).toUpperCase()}`;
    const instructions = [
      `Buat kunci jadwalnya, transfer DP ${formatRupiah(amountRupiah)} ya:`,
      `${PAYMENT_DETAILS.bankName} ${PAYMENT_DETAILS.accountNumber} a.n. ${PAYMENT_DETAILS.accountHolder}`,
      `Bisa juga scan QRIS di ${BUSINESS.shortName}.`,
      `Kalau udah, kirim foto buktinya ke sini ya. Kode booking kamu: ${reference}`,
    ].join('\n');

    return { provider: 'manual_transfer', reference, instructions, amountRupiah };
  }

  async getStatus(reference: string): Promise<PaymentStatusValue> {
    const [row] = await db
      .select({ status: paymentRecord.status })
      .from(paymentRecord)
      .where(eq(paymentRecord.reference, reference))
      .limit(1);
    return row?.status ?? 'pending';
  }
}
