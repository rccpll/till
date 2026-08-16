import { describe, it, expect } from 'vitest';
import { availableList, headerCount, headerTotalCents, historyMonths } from '../src/lib/derive';
import type { Voucher } from '../src/lib/api';

let n = 0;
function v(over: Partial<Voucher>): Voucher {
  n++;
  return {
    id: `v${n}`, issuer: 'coop', symbology: 'gs1-128',
    code: String(n).padStart(34, '0'), gtin: '0'.repeat(14), gs1_serial: String(n).padStart(16, '0'),
    printed_serial: null, face_value_cents: 2000, remaining_cents: 2000,
    expires_at: '2030-01-01', status: 'available',
    created_at: `2026-01-0${(n % 9) + 1}T10:00:00Z`, created_by: 'a@x',
    used_at: null, used_by: null,
    ...over,
  };
}

describe('availableList sorting', () => {
  it('puts partial and spent-open first, then soonest expiry, then upload order', () => {
    const fresh1 = v({ expires_at: '2030-06-01', created_at: '2026-01-01T00:00:00Z' });
    const fresh2 = v({ expires_at: '2030-06-01', created_at: '2026-01-02T00:00:00Z' });
    const soon = v({ expires_at: '2029-01-01' });
    const partial = v({ remaining_cents: 500, expires_at: '2031-01-01' });
    const spentOpen = v({ remaining_cents: 0, expires_at: '2031-06-01' });
    const used = v({ status: 'used', remaining_cents: 0 });
    const expired = v({ expires_at: '2020-01-01' });

    const list = availableList([fresh1, fresh2, soon, partial, spentOpen, used, expired]);
    expect(list.map(x => x.id)).toEqual([partial.id, spentOpen.id, soon.id, fresh1.id, fresh2.id]);
  });
});

describe('header numbers', () => {
  it('total sums spendable remaining; count excludes empty-but-open rows', () => {
    const a = v({ remaining_cents: 2000 });
    const b = v({ remaining_cents: 500 });
    const zero = v({ remaining_cents: 0 });
    const used = v({ status: 'used', remaining_cents: 0 });
    const expired = v({ expires_at: '2020-01-01', remaining_cents: 2000 });
    const all = [a, b, zero, used, expired];
    expect(headerTotalCents(all)).toBe(2500);
    expect(headerCount(all)).toBe(2);
  });
});

describe('historyMonths', () => {
  it('groups reverse-chronologically by month with a spent total (used only)', () => {
    const usedJan = v({ status: 'used', used_at: '2026-01-15T10:00:00Z', face_value_cents: 2000 });
    const usedJan2 = v({ status: 'used', used_at: '2026-01-20T10:00:00Z', face_value_cents: 500 });
    const usedFeb = v({ status: 'used', used_at: '2026-02-02T10:00:00Z', face_value_cents: 5000 });
    const voidedFeb = v({ status: 'voided', used_at: '2026-02-10T10:00:00Z' });
    const expired = v({ expires_at: '2026-01-31' });

    const months = historyMonths([usedJan, usedJan2, usedFeb, voidedFeb, expired]);
    expect(months.map(m => m.key)).toEqual(['2026-02', '2026-01']);
    expect(months[0].spentCents).toBe(5000); // voided excluded
    expect(months[1].spentCents).toBe(2500);
    expect(months[1].entries.map(e => e.kind)).toContain('expired');
    expect(months[0].label).toBe('February 2026');
  });
});
