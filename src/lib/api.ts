// Typed API client. Cloudflare Access authenticates via cookies; the server
// re-verifies the JWT on every call.

export interface Voucher {
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
  status: 'available' | 'used' | 'voided';
  created_at: string;
  created_by: string;
  used_at: string | null;
  used_by: string | null;
}

export interface VoucherEvent {
  id: number;
  voucher_id: string;
  type: 'added' | 'spent' | 'used' | 'unmarked' | 'voided' | 'already_empty' | 'scan_failed';
  amount_cents: number | null;
  previous_remaining_cents: number | null;
  actor: string;
  note: string | null;
  client_action_id: string | null;
  created_at: string;
}

export interface AppState {
  /** the verified email of the logged-in user */
  me: string;
  vouchers: Voucher[];
  gtin_amounts: Record<string, number>;
  last_export_at: string | null;
}

export interface AddRow {
  code: string;
  gtin: string;
  gs1_serial: string;
  printed_serial?: string | null;
  face_value_cents: number;
  expires_at: string;
  issuer: string;
  barcode_png_b64?: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`HTTP ${status}`);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export const api = {
  state: () => request<AppState>('GET', '/api/state'),
  addVouchers: (rows: AddRow[]) =>
    request<{ added: Voucher[]; skipped_duplicates: string[] }>('POST', '/api/vouchers', rows),
  events: (id: string) => request<{ events: VoucherEvent[] }>('GET', `/api/vouchers/${id}/events`),
  use: (id: string, body: object) => request<{ voucher: Voucher }>('POST', `/api/vouchers/${id}/use`, body),
  spend: (id: string, body: object) => request<{ voucher: Voucher }>('POST', `/api/vouchers/${id}/spend`, body),
  alreadyEmpty: (id: string, body: object) => request<{ voucher: Voucher }>('POST', `/api/vouchers/${id}/already_empty`, body),
  scanFailed: (id: string, body: object) => request<{ voucher: Voucher }>('POST', `/api/vouchers/${id}/scan_failed`, body),
  unmark: (id: string, body: object) => request<{ voucher: Voucher }>('POST', `/api/vouchers/${id}/unmark`, body),
  void: (id: string, body: object) => request<{ voucher: Voucher }>('POST', `/api/vouchers/${id}/void`, body),
};
