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

/** The Access session expired: the user has to sign in again (signInUrl). */
export class AuthExpiredError extends Error {
  constructor() {
    super('signed out');
  }
}

// Access answers an expired session with a redirect to its login page. Fetched
// with redirect: 'manual' that is an opaque redirect (status 0) rather than a
// CORS failure indistinguishable from being offline.
export function isAuthFailure(res: Response): boolean {
  return res.type === 'opaqueredirect' || res.status === 401 || res.status === 403;
}

/**
 * Full-page navigation target that goes through Access's login and comes back
 * to `next`. A navigation, not a fetch: the service worker never serves /api/*.
 */
export function signInUrl(next = '/'): string {
  return `/api/login?next=${encodeURIComponent(next)}`;
}

/** fetch for /api/*: throws AuthExpiredError instead of following Access's login redirect. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { ...init, redirect: 'manual' });
  if (isAuthFailure(res)) throw new AuthExpiredError();
  return res;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
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
