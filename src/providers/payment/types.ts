/**
 * Payments. Manual bank/QRIS transfer is the REAL product at this tier, not a stub:
 * the owner reads a bukti transfer and decides. A gateway registered under the
 * developer's name would route the client's revenue into the developer's bank
 * account and tax ID, which is why one is not used here.
 */
export type PaymentStatusValue = 'pending' | 'paid' | 'expired';

export interface DpRequest {
  provider: string;
  reference: string;
  /** Customer-facing text, already in casual Indonesian. */
  instructions: string;
  amountRupiah: number;
}

export interface PaymentProvider {
  createDpRequest(bookingId: string, amountRupiah: number): Promise<DpRequest>;
  getStatus(reference: string): Promise<PaymentStatusValue>;
}
