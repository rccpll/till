// Row shapes and JSON mappers. Money is integer cents everywhere.

export type VoucherStatus = 'available' | 'used' | 'voided';
export type EventType =
  | 'added' | 'spent' | 'used' | 'unmarked' | 'voided' | 'already_empty' | 'scan_failed';

export interface VoucherRow {
  id: string;
  issuer: string;
  symbology: string;
  code: string;
  gtin: string;
  gs1_serial: string;
  printed_serial: string | null;
  face_value_cents: number;
  remaining_cents: number;
  expires_at: string;
  status: VoucherStatus;
  created_at: string;
  created_by: string;
  used_at: string | null;
  used_by: string | null;
}

export interface EventRow {
  id: number;
  voucher_id: string;
  type: EventType;
  amount_cents: number | null;
  previous_remaining_cents: number | null;
  actor: string;
  note: string | null;
  client_action_id: string | null;
  created_at: string;
}

/** Every voucher column except the blob — what list endpoints return. */
export const VOUCHER_COLS =
  'id, issuer, symbology, code, gtin, gs1_serial, printed_serial, face_value_cents, ' +
  'remaining_cents, expires_at, status, created_at, created_by, used_at, used_by';

export function b64encode(buf: ArrayBuffer | Uint8Array | number[]): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayBuffer | number[] & ArrayLike<number>);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
