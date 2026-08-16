// Offline action queue (IndexedDB). Every write is enqueued with a
// client_action_id, applied optimistically, and flushed FIFO on reconnect.
// The server's idempotency makes double-flush harmless; its 409s make
// semantically refused actions permanent rejections (never retried).
import { openDB, type IDBPDatabase } from 'idb';
import type { Voucher } from './api';

export type ActionEndpoint = 'use' | 'spend' | 'already_empty' | 'unmark' | 'void' | 'scan_failed';

export interface QueuedAction {
  seq?: number;
  client_action_id: string;
  voucher_id: string;
  endpoint: ActionEndpoint;
  /** extra body fields (used_cents, note, …) */
  params: Record<string, unknown>;
  actor: string;
  client_ts: string;
  tries: number;
}

export interface Rejection {
  seq?: number;
  action: QueuedAction;
  status: number;
  body: unknown;
  rejected_at: string;
}

const DB_NAME = 'till';
const DB_VERSION = 1;

function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('queue')) {
        d.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
      }
      if (!d.objectStoreNames.contains('rejections')) {
        d.createObjectStore('rejections', { keyPath: 'seq', autoIncrement: true });
      }
      if (!d.objectStoreNames.contains('cache')) {
        d.createObjectStore('cache');
      }
    },
  });
}

// ---- state cache (last known /api/state, so the wallet renders offline)

export async function readCachedState<T>(): Promise<T | null> {
  return (await (await db()).get('cache', 'state')) ?? null;
}

export async function writeCachedState(state: unknown): Promise<void> {
  await (await db()).put('cache', state, 'state');
}

// ---- queue

export async function enqueue(action: Omit<QueuedAction, 'seq' | 'tries'>): Promise<void> {
  await (await db()).add('queue', { ...action, tries: 0 });
}

export async function listQueue(): Promise<QueuedAction[]> {
  return (await db()).getAll('queue');
}

export async function removeQueued(seq: number): Promise<void> {
  await (await db()).delete('queue', seq);
}

export async function bumpTries(action: QueuedAction): Promise<void> {
  await (await db()).put('queue', { ...action, tries: action.tries + 1 });
}

// ---- rejections (409s and other permanent refusals, until dismissed)

export async function addRejection(r: Omit<Rejection, 'seq'>): Promise<void> {
  await (await db()).add('rejections', r);
}

export async function listRejections(): Promise<Rejection[]> {
  return (await db()).getAll('rejections');
}

export async function dismissRejection(seq: number): Promise<void> {
  await (await db()).delete('rejections', seq);
}

// ---- optimistic replay: cached server state + queued actions = displayed state

export function applyAction(v: Voucher, a: QueuedAction): Voucher {
  switch (a.endpoint) {
    case 'use':
      return { ...v, remaining_cents: 0, status: 'used', used_at: a.client_ts, used_by: a.actor };
    case 'already_empty':
      return { ...v, remaining_cents: 0, status: 'used', used_at: a.client_ts, used_by: a.actor };
    case 'spend': {
      const used = typeof a.params.used_cents === 'number'
        ? a.params.used_cents
        : v.remaining_cents - (a.params.remaining_cents as number);
      return { ...v, remaining_cents: Math.max(0, v.remaining_cents - used) };
    }
    case 'unmark':
      // the queue can't know the exact prior remaining; show it available and
      // let the server's authoritative answer replace this on sync
      return { ...v, status: 'available', used_at: null, used_by: null };
    case 'void':
      return { ...v, status: 'voided', used_at: a.client_ts, used_by: a.actor };
    case 'scan_failed':
      return v;
  }
}

export function replayQueue(vouchers: Voucher[], queue: QueuedAction[]): Voucher[] {
  if (!queue.length) return vouchers;
  const byId = new Map(vouchers.map(v => [v.id, v]));
  for (const a of [...queue].sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0))) {
    const v = byId.get(a.voucher_id);
    if (v) byId.set(v.id, applyAction(v, a));
  }
  return vouchers.map(v => byId.get(v.id)!);
}
