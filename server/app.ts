// Till API. Correctness rules that must never be violated:
//  - every state change appends an event in the SAME atomic batch as the update
//  - a use/already_empty/void on a voucher that is already used/voided is a 409,
//    never a silent overwrite — first use wins
//  - partial spends stack and validate against CURRENT remaining, not face value
//  - reaching zero via spend does NOT close the voucher (status stays 'available')
//  - duplicates on add are dropped entirely: no row, no event
//  - client_action_id replays return the original outcome, never apply twice
import { Hono, type Context } from 'hono';
import { requireAccess } from './auth';
import type { Env } from './env';
import {
  VOUCHER_COLS, b64decode, b64encode,
  type EventRow, type EventType, type VoucherRow,
} from './db';

type Ctx = { Bindings: Env; Variables: { actor: string } };

const app = new Hono<Ctx>().basePath('/api');
app.use('*', requireAccess);

const now = () => new Date().toISOString();

// ---------------------------------------------------------------- helpers

async function getVoucher(db: D1Database, id: string): Promise<VoucherRow | null> {
  return db.prepare(`SELECT ${VOUCHER_COLS} FROM vouchers WHERE id = ?`)
    .bind(id).first<VoucherRow>();
}

async function findReplay(db: D1Database, clientActionId: string | undefined) {
  if (!clientActionId) return null;
  return db.prepare('SELECT * FROM voucher_events WHERE client_action_id = ?')
    .bind(clientActionId).first<EventRow>();
}

function eventInsert(
  db: D1Database,
  e: {
    voucher_id: string; type: EventType; actor: string;
    amount_cents?: number | null; previous_remaining_cents?: number | null;
    note?: string | null; client_action_id?: string | null;
  },
) {
  return db.prepare(
    `INSERT INTO voucher_events
       (voucher_id, type, amount_cents, previous_remaining_cents, actor, note, client_action_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    e.voucher_id, e.type, e.amount_cents ?? null, e.previous_remaining_cents ?? null,
    e.actor, e.note ?? null, e.client_action_id ?? null, now(),
  );
}

function conflict(v: VoucherRow) {
  return {
    reason: v.status === 'voided' ? 'voided' : 'already_used',
    status: v.status,
    used_by: v.used_by,
    used_at: v.used_at,
  };
}

/** Replay response for an already-applied client_action_id. */
async function replayResponse(db: D1Database, event: EventRow) {
  const voucher = await getVoucher(db, event.voucher_id);
  return { replayed: true, voucher };
}

// ---------------------------------------------------------------- state

app.get('/state', async (c) => {
  const db = c.env.DB;
  const [vouchers, gtins, meta] = await Promise.all([
    db.prepare(`SELECT ${VOUCHER_COLS} FROM vouchers ORDER BY created_at, id`).all<VoucherRow>(),
    db.prepare('SELECT gtin, face_value_cents FROM gtin_amounts').all<{ gtin: string; face_value_cents: number }>(),
    db.prepare("SELECT v FROM app_meta WHERE k = 'last_export_at'").first<{ v: string }>(),
  ]);
  const gtin_amounts: Record<string, number> = {};
  for (const g of gtins.results) gtin_amounts[g.gtin] = g.face_value_cents;
  return c.json({
    me: c.var.actor,
    vouchers: vouchers.results,
    gtin_amounts,
    last_export_at: meta?.v ?? null,
  });
});

// ---------------------------------------------------------------- add (batch)

interface AddRow {
  code: string;
  gtin: string;
  gs1_serial: string;
  printed_serial?: string | null;
  face_value_cents: number;
  expires_at: string;
  issuer: string;
  barcode_png_b64?: string | null;
}

function validateAddRow(r: AddRow): string | null {
  if (typeof r.code !== 'string' || !/^\d{34}$/.test(r.code)) return 'code must be 34 digits';
  // the only format we parse today: (01) GTIN-14 + (21) serial
  if (!r.code.startsWith('01') || r.code.slice(16, 18) !== '21') return 'code is not (01)(21) GS1';
  if (r.gtin !== r.code.slice(2, 16)) return 'gtin does not match code';
  if (r.gs1_serial !== r.code.slice(18)) return 'gs1_serial does not match code';
  if (!Number.isInteger(r.face_value_cents) || r.face_value_cents <= 0) return 'face_value_cents must be a positive integer';
  if (typeof r.expires_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.expires_at)) return 'expires_at must be yyyy-mm-dd';
  if (typeof r.issuer !== 'string' || r.issuer.trim() === '') return 'issuer (gift-card group) is required';
  return null;
}

app.post('/vouchers', async (c) => {
  const db = c.env.DB;
  const actor = c.var.actor;
  const body = await c.req.json<AddRow[]>().catch(() => null);
  if (!Array.isArray(body) || body.length === 0) return c.json({ error: 'expected a non-empty array' }, 400);
  if (body.length > 100) return c.json({ error: 'too many rows in one batch' }, 400);

  const errors: { code?: string; index: number; error: string }[] = [];
  const candidates: AddRow[] = [];
  body.forEach((r, index) => {
    const err = validateAddRow(r);
    if (err) errors.push({ code: typeof r?.code === 'string' ? r.code : undefined, index, error: err });
    else candidates.push({ ...r, issuer: r.issuer.trim() });
  });
  if (errors.length) return c.json({ error: 'invalid rows', rows: errors }, 400);

  // duplicates: already in DB, or repeated within this batch — dropped entirely
  const skipped_duplicates: string[] = [];
  const seen = new Set<string>();
  const fresh: AddRow[] = [];
  for (const r of candidates) {
    if (seen.has(r.code)) { skipped_duplicates.push(r.code); continue; }
    seen.add(r.code);
    const existing = await db.prepare('SELECT id FROM vouchers WHERE code = ?').bind(r.code).first();
    if (existing) skipped_duplicates.push(r.code);
    else fresh.push(r);
  }

  const added: VoucherRow[] = [];
  const stmts: D1PreparedStatement[] = [];
  const ts = now();
  for (const r of fresh) {
    const id = crypto.randomUUID();
    stmts.push(db.prepare(
      `INSERT INTO vouchers
         (id, issuer, symbology, code, gtin, gs1_serial, printed_serial,
          face_value_cents, remaining_cents, expires_at, status, barcode_png, created_at, created_by)
       VALUES (?, ?, 'gs1-128', ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
    ).bind(
      id, r.issuer, r.code, r.gtin, r.gs1_serial, r.printed_serial ?? null,
      r.face_value_cents, r.face_value_cents, r.expires_at,
      r.barcode_png_b64 ? b64decode(r.barcode_png_b64) : null, ts, actor,
    ));
    stmts.push(eventInsert(db, {
      voucher_id: id, type: 'added', actor,
      amount_cents: r.face_value_cents, previous_remaining_cents: null,
    }));
    stmts.push(db.prepare(
      `INSERT INTO gtin_amounts (gtin, face_value_cents, confirmed_by, confirmed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(gtin) DO UPDATE SET face_value_cents = excluded.face_value_cents,
         confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at`,
    ).bind(r.gtin, r.face_value_cents, actor, ts));
    added.push({
      id, issuer: r.issuer, symbology: 'gs1-128', code: r.code, gtin: r.gtin,
      gs1_serial: r.gs1_serial, printed_serial: r.printed_serial ?? null,
      face_value_cents: r.face_value_cents, remaining_cents: r.face_value_cents,
      expires_at: r.expires_at, status: 'available', created_at: ts, created_by: actor,
      used_at: null, used_by: null,
    });
  }
  if (stmts.length) await db.batch(stmts);
  return c.json({ added, skipped_duplicates });
});

// ---------------------------------------------------------------- state changes

interface WriteBody {
  client_action_id?: string;
  used_cents?: number;
  remaining_cents?: number;
  note?: string;
  /** Offline queue: when the action actually happened on the client. */
  client_ts?: string;
}

async function readWriteBody(c: { req: { json: <T>() => Promise<T> } }): Promise<WriteBody> {
  try { return await (c.req.json<WriteBody>()); } catch { return {}; }
}

/**
 * Shared implementation for use / already_empty: close the voucher.
 * Guarded by current status — first use wins, later ones get 409.
 */
async function closeVoucher(c: Context<Ctx, '/vouchers/:id/use' | '/vouchers/:id/already_empty'>, type: 'used' | 'already_empty') {
  const db = c.env.DB;
  const actor = c.var.actor;
  const id = c.req.param('id');
  const body = await readWriteBody(c);

  const replay = await findReplay(db, body.client_action_id);
  if (replay) return c.json(await replayResponse(db, replay));

  const v = await getVoucher(db, id);
  if (!v) return c.json({ error: 'not found' }, 404);
  if (v.status !== 'available') return c.json(conflict(v), 409);

  const ts = body.client_ts ?? now();
  const upd = await db.batch([
    db.prepare(
      `UPDATE vouchers SET remaining_cents = 0, status = 'used', used_at = ?, used_by = ?
       WHERE id = ? AND status = 'available' AND remaining_cents = ?`,
    ).bind(ts, actor, id, v.remaining_cents),
    eventInsert(db, {
      voucher_id: id, type, actor,
      amount_cents: type === 'used' ? v.remaining_cents : null,
      previous_remaining_cents: v.remaining_cents,
      note: body.note ?? null,
      client_action_id: body.client_action_id ?? null,
    }),
  ]);
  if ((upd[0].meta.changes ?? 0) === 0) {
    // lost a race: someone changed it between our read and the guarded update
    const fresh = await getVoucher(db, id);
    return c.json(conflict(fresh!), 409);
  }
  return c.json({ voucher: await getVoucher(db, id) });
}

app.post('/vouchers/:id/use', (c) => closeVoucher(c, 'used'));
app.post('/vouchers/:id/already_empty', (c) => closeVoucher(c, 'already_empty'));

app.post('/vouchers/:id/spend', async (c) => {
  const db = c.env.DB;
  const actor = c.var.actor;
  const id = c.req.param('id');
  const body = await readWriteBody(c);

  const replay = await findReplay(db, body.client_action_id);
  if (replay) return c.json(await replayResponse(db, replay));

  const v = await getVoucher(db, id);
  if (!v) return c.json({ error: 'not found' }, 404);
  if (v.status !== 'available') return c.json(conflict(v), 409);

  // accept either used_cents or remaining_cents; validate against CURRENT remaining
  let usedCents: number;
  if (body.used_cents !== undefined) {
    if (!Number.isInteger(body.used_cents) || body.used_cents <= 0) {
      return c.json({ error: 'used_cents must be a positive integer' }, 400);
    }
    usedCents = body.used_cents;
  } else if (body.remaining_cents !== undefined) {
    if (!Number.isInteger(body.remaining_cents) || body.remaining_cents < 0) {
      return c.json({ error: 'remaining_cents must be a non-negative integer' }, 400);
    }
    usedCents = v.remaining_cents - body.remaining_cents;
    if (usedCents <= 0) return c.json({ error: 'remaining_cents must be lower than the current remaining amount' }, 400);
  } else {
    return c.json({ error: 'used_cents or remaining_cents required' }, 400);
  }
  if (usedCents > v.remaining_cents) {
    return c.json({ error: `used_cents exceeds remaining (${v.remaining_cents})` }, 400);
  }

  const newRemaining = v.remaining_cents - usedCents;
  const upd = await db.batch([
    db.prepare(
      // reaching zero does NOT auto-close: status stays 'available'
      `UPDATE vouchers SET remaining_cents = ?
       WHERE id = ? AND status = 'available' AND remaining_cents = ?`,
    ).bind(newRemaining, id, v.remaining_cents),
    eventInsert(db, {
      voucher_id: id, type: 'spent', actor,
      amount_cents: usedCents, previous_remaining_cents: v.remaining_cents,
      note: body.note ?? null,
      client_action_id: body.client_action_id ?? null,
    }),
  ]);
  if ((upd[0].meta.changes ?? 0) === 0) {
    const fresh = await getVoucher(db, id);
    if (!fresh || fresh.status !== 'available') return c.json(conflict(fresh!), 409);
    return c.json({ error: 'concurrent modification, retry with fresh state' }, 409);
  }
  return c.json({ voucher: await getVoucher(db, id) });
});

app.post('/vouchers/:id/scan_failed', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await readWriteBody(c);
  const replay = await findReplay(db, body.client_action_id);
  if (replay) return c.json(await replayResponse(db, replay));
  const v = await getVoucher(db, id);
  if (!v) return c.json({ error: 'not found' }, 404);
  await db.batch([
    eventInsert(db, {
      voucher_id: id, type: 'scan_failed', actor: c.var.actor,
      previous_remaining_cents: v.remaining_cents,
      note: body.note ?? null,
      client_action_id: body.client_action_id ?? null,
    }),
  ]);
  return c.json({ voucher: v });
});

app.post('/vouchers/:id/unmark', async (c) => {
  const db = c.env.DB;
  const actor = c.var.actor;
  const id = c.req.param('id');
  const body = await readWriteBody(c);

  const replay = await findReplay(db, body.client_action_id);
  if (replay) return c.json(await replayResponse(db, replay));

  const v = await getVoucher(db, id);
  if (!v) return c.json({ error: 'not found' }, 404);

  // the latest event that changed remaining/status is what we roll back
  const last = await db.prepare(
    `SELECT * FROM voucher_events
     WHERE voucher_id = ? AND type IN ('spent','used','already_empty','voided')
     ORDER BY id DESC LIMIT 1`,
  ).bind(id).first<EventRow>();
  if (!last || last.previous_remaining_cents === null) {
    return c.json({ error: 'nothing to unmark' }, 409);
  }

  const upd = await db.batch([
    db.prepare(
      `UPDATE vouchers SET remaining_cents = ?, status = 'available', used_at = NULL, used_by = NULL
       WHERE id = ? AND status = ? AND remaining_cents = ?`,
    ).bind(last.previous_remaining_cents, id, v.status, v.remaining_cents),
    eventInsert(db, {
      voucher_id: id, type: 'unmarked', actor,
      amount_cents: last.amount_cents,
      previous_remaining_cents: v.remaining_cents,
      note: `rolled back event ${last.id} (${last.type})`,
      client_action_id: body.client_action_id ?? null,
    }),
  ]);
  if ((upd[0].meta.changes ?? 0) === 0) {
    return c.json({ error: 'concurrent modification, retry with fresh state' }, 409);
  }
  return c.json({ voucher: await getVoucher(db, id) });
});

app.post('/vouchers/:id/void', async (c) => {
  const db = c.env.DB;
  const actor = c.var.actor;
  const id = c.req.param('id');
  const body = await readWriteBody(c);

  const replay = await findReplay(db, body.client_action_id);
  if (replay) return c.json(await replayResponse(db, replay));

  const v = await getVoucher(db, id);
  if (!v) return c.json({ error: 'not found' }, 404);
  if (v.status !== 'available') return c.json(conflict(v), 409);

  // void records who/when in used_at/used_by ("closed at"), so History can
  // place it in a month and conflicts can say who closed it
  const upd = await db.batch([
    db.prepare(
      `UPDATE vouchers SET status = 'voided', used_at = ?, used_by = ? WHERE id = ? AND status = 'available'`,
    ).bind(body.client_ts ?? now(), actor, id),
    eventInsert(db, {
      voucher_id: id, type: 'voided', actor,
      previous_remaining_cents: v.remaining_cents,
      note: body.note ?? null,
      client_action_id: body.client_action_id ?? null,
    }),
  ]);
  if ((upd[0].meta.changes ?? 0) === 0) {
    const fresh = await getVoucher(db, id);
    return c.json(conflict(fresh!), 409);
  }
  return c.json({ voucher: await getVoucher(db, id) });
});

// ---------------------------------------------------------------- reads

app.get('/vouchers/:id/events', async (c) => {
  const events = await c.env.DB.prepare(
    'SELECT * FROM voucher_events WHERE voucher_id = ? ORDER BY id',
  ).bind(c.req.param('id')).all<EventRow>();
  return c.json({ events: events.results });
});

app.get('/vouchers/:id/original.png', async (c) => {
  const row = await c.env.DB.prepare('SELECT barcode_png FROM vouchers WHERE id = ?')
    .bind(c.req.param('id')).first<{ barcode_png: ArrayBuffer | number[] | null }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (!row.barcode_png) return c.json({ error: 'no original image stored' }, 404);
  // D1 hands BLOB columns back as a plain number array
  const bytes = Array.isArray(row.barcode_png) ? new Uint8Array(row.barcode_png) : row.barcode_png;
  return c.body(bytes, 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});

app.get('/export', async (c) => {
  const db = c.env.DB;
  const ts = now();
  const [vouchers, events, gtins] = await Promise.all([
    db.prepare('SELECT * FROM vouchers ORDER BY created_at, id').all<VoucherRow & { barcode_png: number[] | null }>(),
    db.prepare('SELECT * FROM voucher_events ORDER BY id').all<EventRow>(),
    db.prepare('SELECT * FROM gtin_amounts').all(),
  ]);
  await db.prepare(
    `INSERT INTO app_meta (k, v) VALUES ('last_export_at', ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  ).bind(ts).run();
  return c.json({
    exported_at: ts,
    vouchers: vouchers.results.map((v) => ({
      ...v,
      barcode_png: v.barcode_png ? b64encode(v.barcode_png) : null,
    })),
    events: events.results,
    gtin_amounts: gtins.results,
  }, 200, {
    'Content-Disposition': `attachment; filename="till-${ts.slice(0, 10)}.export.json"`,
  });
});

export default app;
