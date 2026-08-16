/**
 * 2000 -> "20,00 €" (Italian format, as printed on receipts).
 * Formatted by hand: runtime ICU support varies (workerd drops grouping).
 */
export function euros(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const frac = (abs % 100).toString().padStart(2, '0');
  return `${sign}${whole},${frac} €`;
}

/** "2027-11-28" -> "28/11/2027" */
export function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Parse a user-typed amount like "13,47" / "13.47" / "20" into cents, or null. */
export function parseEuros(input: string): number | null {
  const t = input.trim().replace(/€/g, '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(parseFloat(t) * 100);
}
