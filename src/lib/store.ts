// The wallet's single source of truth: cached server state + queued offline
// actions, exposed to React via useSyncExternalStore.
//
// Display state = last-known server state with the pending queue replayed on
// top. Flushing is FIFO; a network/5xx failure pauses the queue (retried with
// backoff and on 'online'), a 4xx removes the action and records a rejection
// that must be dismissed by hand.
import { useSyncExternalStore } from 'react';
import type { AppState, Voucher } from './api';
import {
  addRejection, bumpTries, dismissRejection as idbDismissRejection, enqueue,
  listQueue, listRejections, readCachedState, removeQueued, replayQueue,
  writeCachedState, type ActionEndpoint, type QueuedAction, type Rejection,
} from './queue';

export interface WalletState {
  /** replayed view: server state + pending actions */
  vouchers: Voucher[];
  me: string | null;
  gtinAmounts: Record<string, number>;
  lastExportAt: string | null;
  /** voucher ids with actions still waiting to sync */
  pendingIds: Set<string>;
  /** refused actions awaiting manual dismissal (the blocking banner) */
  rejections: Rejection[];
  online: boolean;
  loaded: boolean;
}

interface Internal {
  server: AppState | null;
  queue: QueuedAction[];
  rejections: Rejection[];
  online: boolean;
  loaded: boolean;
}

const internal: Internal = {
  server: null,
  queue: [],
  rejections: [],
  online: navigator.onLine,
  loaded: false,
};

let snapshot: WalletState = compute();
const listeners = new Set<() => void>();

function compute(): WalletState {
  return {
    vouchers: internal.server ? replayQueue(internal.server.vouchers, internal.queue) : [],
    me: internal.server?.me ?? null,
    gtinAmounts: internal.server?.gtin_amounts ?? {},
    lastExportAt: internal.server?.last_export_at ?? null,
    pendingIds: new Set(internal.queue.map(a => a.voucher_id)),
    rejections: internal.rejections,
    online: internal.online,
    loaded: internal.loaded,
  };
}

function emit() {
  snapshot = compute();
  for (const l of listeners) l();
}

export function useWallet(): WalletState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => snapshot,
  );
}

export function getVoucher(id: string): Voucher | undefined {
  return snapshot.vouchers.find(v => v.id === id);
}

// ------------------------------------------------------------------ boot

let booted = false;

export async function boot(): Promise<void> {
  if (booted) return;
  booted = true;

  window.addEventListener('online', () => { internal.online = true; emit(); void flush(); });
  window.addEventListener('offline', () => { internal.online = false; emit(); });

  // 1. hydrate from cache instantly (the barcode must render offline)
  const cached = await readCachedState<AppState>();
  if (cached) internal.server = cached;
  internal.queue = await listQueue();
  internal.rejections = await listRejections();
  internal.loaded = internal.server != null;
  emit();

  // 2. then revalidate over the network
  await flush();
  await refresh();
}

export async function refresh(): Promise<void> {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) return;
    const state = await res.json() as AppState;
    internal.server = state;
    internal.loaded = true;
    await writeCachedState(state);
    emit();
  } catch {
    // offline — cached view stands
  }
}

// ------------------------------------------------------------------ actions

async function act(endpoint: ActionEndpoint, voucherId: string, params: Record<string, unknown> = {}): Promise<void> {
  const action: Omit<QueuedAction, 'seq' | 'tries'> = {
    client_action_id: crypto.randomUUID(),
    voucher_id: voucherId,
    endpoint,
    params,
    actor: snapshot.me ?? 'unknown',
    client_ts: new Date().toISOString(),
  };
  await enqueue(action);
  internal.queue = await listQueue();
  emit();
  void flush();
}

export const actions = {
  use: (id: string) => act('use', id),
  alreadyEmpty: (id: string) => act('already_empty', id),
  spend: (id: string, used_cents: number) => act('spend', id, { used_cents }),
  unmark: (id: string) => act('unmark', id),
  void: (id: string, note: string) => act('void', id, { note }),
  scanFailed: (id: string) => act('scan_failed', id),
};

export async function dismissRejection(seq: number): Promise<void> {
  await idbDismissRejection(seq);
  internal.rejections = await listRejections();
  emit();
  // reconcile: the server won that conflict, show its truth
  await refresh();
}

// ------------------------------------------------------------------ flush

let flushing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export async function flush(): Promise<void> {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    for (const action of [...internal.queue].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
      let res: Response;
      try {
        res = await fetch(`/api/vouchers/${action.voucher_id}/${action.endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...action.params,
            client_action_id: action.client_action_id,
            client_ts: action.client_ts,
          }),
        });
      } catch {
        scheduleRetry(action);
        return; // offline/unreachable — keep FIFO order, try again later
      }

      if (res.ok) {
        await removeQueued(action.seq!);
        const body = await res.json().catch(() => null) as { voucher?: Voucher } | null;
        if (body?.voucher && internal.server) {
          internal.server = {
            ...internal.server,
            vouchers: internal.server.vouchers.map(v => v.id === body.voucher!.id ? body.voucher! : v),
          };
          await writeCachedState(internal.server);
        }
      } else if (res.status >= 500) {
        scheduleRetry(action);
        return;
      } else {
        // semantic refusal (409 double-use, 400, …): never retry — record it
        await removeQueued(action.seq!);
        await addRejection({
          action,
          status: res.status,
          body: await res.json().catch(() => null),
          rejected_at: new Date().toISOString(),
        });
        internal.rejections = await listRejections();
      }
      internal.queue = await listQueue();
      emit();
    }
  } finally {
    flushing = false;
  }
}

function scheduleRetry(action: QueuedAction): void {
  void bumpTries(action).then(async () => {
    internal.queue = await listQueue();
    emit();
  });
  if (retryTimer) clearTimeout(retryTimer);
  const delay = Math.min(5_000 * 2 ** action.tries, 300_000);
  retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, delay);
}
