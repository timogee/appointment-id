/**
 * Money is an integer number of rupiah. Never float, never decimal, never string.
 * There are no sub-rupiah amounts in this business.
 */
export type Rupiah = number;

export function assertRupiah(value: number): Rupiah {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Rupiah must be an integer, got ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`Rupiah must not be negative, got ${value}`);
  }
  return value;
}

/** Display only. "Rp 65.000" */
export function formatRupiah(value: Rupiah): string {
  return `Rp ${assertRupiah(value).toLocaleString('id-ID')}`;
}
