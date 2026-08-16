// Derived views over vouchers — nothing here is ever stored (no cron jobs).
import type { Voucher } from './api';

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isExpired(v: Voucher, today = todayIso()): boolean {
  return v.expires_at < today;
}

export function isPartial(v: Voucher): boolean {
  return v.status === 'available' && v.remaining_cents > 0 && v.remaining_cents < v.face_value_cents;
}

export function isSpentOpen(v: Voucher): boolean {
  return v.status === 'available' && v.remaining_cents === 0;
}

/** Available tab: spendable now (not expired). Sorted: partial/spent first → soonest expiry → upload order. */
export function availableList(vouchers: Voucher[]): Voucher[] {
  const today = todayIso();
  return vouchers
    .filter(v => v.status === 'available' && !isExpired(v, today))
    .sort((a, b) => {
      const aTouched = isPartial(a) || isSpentOpen(a) ? 0 : 1;
      const bTouched = isPartial(b) || isSpentOpen(b) ? 0 : 1;
      if (aTouched !== bTouched) return aTouched - bTouched;
      if (a.expires_at !== b.expires_at) return a.expires_at < b.expires_at ? -1 : 1;
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
}

/** Header total: what is actually spendable. */
export function headerTotalCents(vouchers: Voucher[]): number {
  const today = todayIso();
  return vouchers
    .filter(v => v.status === 'available' && !isExpired(v, today))
    .reduce((s, v) => s + v.remaining_cents, 0);
}

/** Header count: available rows excluding the empty-but-open ones. */
export function headerCount(vouchers: Voucher[]): number {
  const today = todayIso();
  return vouchers
    .filter(v => v.status === 'available' && !isExpired(v, today) && v.remaining_cents > 0)
    .length;
}

export function expiresSoon(v: Voucher, days = 60): boolean {
  const limit = new Date();
  limit.setDate(limit.getDate() + days);
  const iso = `${limit.getFullYear()}-${String(limit.getMonth() + 1).padStart(2, '0')}-${String(limit.getDate()).padStart(2, '0')}`;
  return v.expires_at <= iso;
}

export interface HistoryEntry {
  voucher: Voucher;
  kind: 'used' | 'voided' | 'expired';
  /** ISO date used for ordering/grouping */
  when: string;
}

export interface HistoryMonth {
  key: string;      // "2026-08"
  label: string;    // "August 2026"
  entries: HistoryEntry[];
  spentCents: number;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function historyMonths(vouchers: Voucher[]): HistoryMonth[] {
  const today = todayIso();
  const entries: HistoryEntry[] = [];
  for (const v of vouchers) {
    if (v.status === 'used') entries.push({ voucher: v, kind: 'used', when: v.used_at ?? v.created_at });
    else if (v.status === 'voided') entries.push({ voucher: v, kind: 'voided', when: v.used_at ?? v.created_at });
    else if (isExpired(v, today)) entries.push({ voucher: v, kind: 'expired', when: v.expires_at });
  }
  entries.sort((a, b) => (a.when < b.when ? 1 : -1));

  const months: HistoryMonth[] = [];
  for (const e of entries) {
    const key = e.when.slice(0, 7);
    let m = months[months.length - 1];
    if (!m || m.key !== key) {
      const [y, mo] = key.split('-');
      m = { key, label: `${MONTHS[parseInt(mo, 10) - 1]} ${y}`, entries: [], spentCents: 0 };
      months.push(m);
    }
    m.entries.push(e);
    if (e.kind === 'used') m.spentCents += e.voucher.face_value_cents;
  }
  return months;
}
