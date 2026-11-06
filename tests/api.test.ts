// API tests, mapped to the acceptance criteria (numbers in describe titles).
import { describe, it, expect } from 'vitest';
import { call, addOne, makeVoucher, tokenFor, ALICE, BOB, TEAM_DOMAIN } from './helpers';

describe('auth (criterion 10)', () => {
  it('403 with no JWT', async () => {
    const res = await call('GET', '/api/state', { token: null });
    expect(res.status).toBe(403);
  });

  it('403 with a garbage JWT', async () => {
    const res = await call('GET', '/api/state', { token: 'not.a.jwt' });
    expect(res.status).toBe(403);
  });

  it('403 with a wrong-audience JWT (token minted for another Access app)', async () => {
    const res = await call('GET', '/api/state', { token: await tokenFor(ALICE, { aud: 'other-app' }) });
    expect(res.status).toBe(403);
  });

  it('403 with a wrong-issuer JWT', async () => {
    const res = await call('GET', '/api/state', { token: await tokenFor(ALICE, { iss: 'https://evil.example.com' }) });
    expect(res.status).toBe(403);
  });

  it('/api/login redirects to the wallet with a valid JWT', async () => {
    const res = await call('GET', '/api/login');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');
  });

  it('/api/login returns to a local `next` path', async () => {
    const res = await call('GET', '/api/login?next=%2Fupload');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/upload');
  });

  it('/api/login never redirects off-site', async () => {
    for (const next of [
      'https://evil.example.com', '//evil.example.com', '/\\evil.example.com', 'upload',
      '/\t/evil.example.com', '/\n/evil.example.com', '/\r\\evil.example.com', '\t//evil.example.com',
    ]) {
      const res = await call('GET', `/api/login?next=${encodeURIComponent(next)}`);
      expect(res.headers.get('Location'), next).toBe('/');
    }
  });

  it('/api/login is 403 without a JWT (Access intercepts it in production)', async () => {
    const res = await call('GET', '/api/login', { token: null });
    expect(res.status).toBe(403);
  });

  it('200 with a valid JWT; actor is the verified email claim', async () => {
    const { voucher } = await addOne();
    const state = await (await call('GET', '/api/state')).json() as { vouchers: { id: string; created_by: string }[] };
    expect(state.vouchers.find(v => v.id === voucher.id)?.created_by).toBe(ALICE);
  });
});

describe('add + dedupe (criterion 3)', () => {
  it('adds a voucher with issuer, full remaining, and an added event', async () => {
    const { row, voucher } = await addOne({ issuer: 'esselunga' });
    expect(voucher).toMatchObject({
      code: row.code,
      issuer: 'esselunga',
      face_value_cents: 2000,
      remaining_cents: 2000,
      status: 'available',
    });
    const events = await (await call('GET', `/api/vouchers/${voucher.id}/events`)).json() as { events: { type: string }[] };
    expect(events.events.map(e => e.type)).toEqual(['added']);
  });

  it('re-adding the same code adds nothing: no row, no event', async () => {
    const { row, voucher } = await addOne();
    const res = await call('POST', '/api/vouchers', { body: [row] });
    const json = await res.json() as { added: unknown[]; skipped_duplicates: string[] };
    expect(json.added).toEqual([]);
    expect(json.skipped_duplicates).toEqual([row.code]);
    const state = await (await call('GET', '/api/state')).json() as { vouchers: { code: string }[] };
    expect(state.vouchers.filter(v => v.code === row.code)).toHaveLength(1);
    const events = await (await call('GET', `/api/vouchers/${voucher.id}/events`)).json() as { events: unknown[] };
    expect(events.events).toHaveLength(1);
  });

  it('duplicates within one batch are dropped too', async () => {
    const row = makeVoucher();
    const res = await call('POST', '/api/vouchers', { body: [row, row] });
    const json = await res.json() as { added: unknown[]; skipped_duplicates: string[] };
    expect(json.added).toHaveLength(1);
    expect(json.skipped_duplicates).toEqual([row.code]);
  });

  it('rejects rows without an issuer (gift-card group is mandatory)', async () => {
    const res = await call('POST', '/api/vouchers', { body: [makeVoucher({ issuer: '  ' })] });
    expect(res.status).toBe(400);
  });

  it('rejects rows whose gtin/serial disagree with the code', async () => {
    const res = await call('POST', '/api/vouchers', { body: [makeVoucher({ gtin: '99999999999999' })] });
    expect(res.status).toBe(400);
  });

  it('upserts gtin_amounts so the amount becomes known', async () => {
    await addOne({ face_value_cents: 5000 });
    const state = await (await call('GET', '/api/state')).json() as { gtin_amounts: Record<string, number> };
    expect(state.gtin_amounts['00000000000000']).toBe(5000);
  });
});

describe('partial spend (criteria 5, 6)', () => {
  it('two sequential 5,00 € spends on a 20,00 € voucher leave 10,00 € and two events', async () => {
    const { voucher } = await addOne();
    const r1 = await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 500 } });
    expect(r1.status).toBe(200);
    const r2 = await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 500 } });
    expect(r2.status).toBe(200);
    const v = (await r2.json() as { voucher: { remaining_cents: number; status: string } }).voucher;
    expect(v.remaining_cents).toBe(1000);
    expect(v.status).toBe('available');
    const events = await (await call('GET', `/api/vouchers/${voucher.id}/events`)).json() as { events: { type: string; amount_cents: number | null; previous_remaining_cents: number | null }[] };
    const spends = events.events.filter(e => e.type === 'spent');
    expect(spends).toHaveLength(2);
    expect(spends.map(e => e.previous_remaining_cents)).toEqual([2000, 1500]);
  });

  it('remaining_cents form computes used from CURRENT remaining, not face value', async () => {
    const { voucher } = await addOne();
    await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 653 } });
    const r = await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { remaining_cents: 1000 } });
    const v = (await r.json() as { voucher: { remaining_cents: number } }).voucher;
    expect(v.remaining_cents).toBe(1000);
    const events = await (await call('GET', `/api/vouchers/${voucher.id}/events`)).json() as { events: { type: string; amount_cents: number | null }[] };
    expect(events.events.filter(e => e.type === 'spent').map(e => e.amount_cents)).toEqual([653, 347]);
  });

  it('spend beyond remaining is rejected', async () => {
    const { voucher } = await addOne();
    await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 1800 } });
    const r = await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 300 } });
    expect(r.status).toBe(400);
  });

  it('spending to exactly zero keeps status available (no auto-close)', async () => {
    const { voucher } = await addOne();
    const r = await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { remaining_cents: 0 } });
    const v = (await r.json() as { voucher: { remaining_cents: number; status: string } }).voucher;
    expect(v).toMatchObject({ remaining_cents: 0, status: 'available' });
    // it still accepts the closing swipe (use) afterwards
    const r2 = await call('POST', `/api/vouchers/${voucher.id}/use`, {});
    expect(r2.status).toBe(200);
    const v2 = (await r2.json() as { voucher: { status: string } }).voucher;
    expect(v2.status).toBe('used');
  });
});

describe('conflicts (criterion 7)', () => {
  it('second use returns 409 with who and when', async () => {
    const { voucher } = await addOne();
    const r1 = await call('POST', `/api/vouchers/${voucher.id}/use`, { email: BOB });
    expect(r1.status).toBe(200);
    const r2 = await call('POST', `/api/vouchers/${voucher.id}/use`, { email: ALICE });
    expect(r2.status).toBe(409);
    const body = await r2.json() as { reason: string; used_by: string; used_at: string };
    expect(body.reason).toBe('already_used');
    expect(body.used_by).toBe(BOB);
    expect(body.used_at).toBeTruthy();
  });

  it('already_empty on a used voucher is refused the same way', async () => {
    const { voucher } = await addOne();
    await call('POST', `/api/vouchers/${voucher.id}/use`, { email: BOB });
    const r = await call('POST', `/api/vouchers/${voucher.id}/already_empty`, {});
    expect(r.status).toBe(409);
  });

  it('spend on a used voucher is refused', async () => {
    const { voucher } = await addOne();
    await call('POST', `/api/vouchers/${voucher.id}/use`, {});
    const r = await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 100 } });
    expect(r.status).toBe(409);
  });

  it('use on a voided voucher reports voided', async () => {
    const { voucher } = await addOne();
    await call('POST', `/api/vouchers/${voucher.id}/void`, { body: { note: 'test' } });
    const r = await call('POST', `/api/vouchers/${voucher.id}/use`, {});
    expect(r.status).toBe(409);
    expect((await r.json() as { reason: string }).reason).toBe('voided');
  });
});

describe('idempotency (criterion 8)', () => {
  it('replaying a use with the same client_action_id applies once', async () => {
    const { voucher } = await addOne();
    const action = { client_action_id: crypto.randomUUID() };
    const r1 = await call('POST', `/api/vouchers/${voucher.id}/use`, { body: action });
    expect(r1.status).toBe(200);
    const r2 = await call('POST', `/api/vouchers/${voucher.id}/use`, { body: action });
    expect(r2.status).toBe(200); // replay, NOT a 409
    expect((await r2.json() as { replayed?: boolean }).replayed).toBe(true);
    const events = await (await call('GET', `/api/vouchers/${voucher.id}/events`)).json() as { events: { type: string }[] };
    expect(events.events.filter(e => e.type === 'used')).toHaveLength(1);
  });

  it('replaying a spend applies once', async () => {
    const { voucher } = await addOne();
    const body = { used_cents: 500, client_action_id: crypto.randomUUID() };
    await call('POST', `/api/vouchers/${voucher.id}/spend`, { body });
    const r2 = await call('POST', `/api/vouchers/${voucher.id}/spend`, { body });
    const v = (await r2.json() as { voucher: { remaining_cents: number } }).voucher;
    expect(v.remaining_cents).toBe(1500); // not 1000
  });
});

describe('unmark (criterion 11)', () => {
  it('restores the exact prior remaining after a full use', async () => {
    const { voucher } = await addOne();
    await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 653 } });
    await call('POST', `/api/vouchers/${voucher.id}/use`, {});
    const r = await call('POST', `/api/vouchers/${voucher.id}/unmark`, {});
    const v = (await r.json() as { voucher: { remaining_cents: number; status: string; used_by: string | null } }).voucher;
    expect(v).toMatchObject({ remaining_cents: 1347, status: 'available', used_by: null });
  });

  it('rolls back a partial spend to the amount before it', async () => {
    const { voucher } = await addOne();
    await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 500 } });
    await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 700 } });
    const r = await call('POST', `/api/vouchers/${voucher.id}/unmark`, {});
    const v = (await r.json() as { voucher: { remaining_cents: number } }).voucher;
    expect(v.remaining_cents).toBe(1500); // undoes only the latest spend
  });

  it('unmark with no state-changing history is refused', async () => {
    const { voucher } = await addOne();
    const r = await call('POST', `/api/vouchers/${voucher.id}/unmark`, {});
    expect(r.status).toBe(409);
  });

  it('restores a voided voucher', async () => {
    const { voucher } = await addOne();
    await call('POST', `/api/vouchers/${voucher.id}/void`, { body: { note: 'oops' } });
    const r = await call('POST', `/api/vouchers/${voucher.id}/unmark`, {});
    const v = (await r.json() as { voucher: { status: string; remaining_cents: number } }).voucher;
    expect(v).toMatchObject({ status: 'available', remaining_cents: 2000 });
  });
});

describe('lost races leave no trace (audit lead 1)', () => {
  type Ev = { type: string; actor: string; client_action_id: string | null; previous_remaining_cents: number | null };
  const events = async (id: string) =>
    ((await (await call('GET', `/api/vouchers/${id}/events`)).json()) as { events: Ev[] }).events;

  it('two simultaneous uses: one wins, the loser writes no event and cannot be replayed', async () => {
    const { voucher } = await addOne();
    const [a, b] = await Promise.all([
      call('POST', `/api/vouchers/${voucher.id}/use`, { body: { client_action_id: 'race-a' } }),
      call('POST', `/api/vouchers/${voucher.id}/use`, { body: { client_action_id: 'race-b' }, email: BOB }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? 'race-a' : 'race-b';

    const used = (await events(voucher.id)).filter(e => e.type === 'used');
    expect(used).toHaveLength(1);
    expect(used[0].client_action_id).not.toBe(loser);

    // the offline queue retrying the losing action must still be told no
    const retry = await call('POST', `/api/vouchers/${voucher.id}/use`, { body: { client_action_id: loser } });
    expect(retry.status).toBe(409);
  });

  it('a spend racing a void: every event matches what was applied', async () => {
    const { voucher } = await addOne();
    await Promise.all([
      call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 500 } }),
      call('POST', `/api/vouchers/${voucher.id}/void`, { body: { note: 'x' }, email: BOB }),
    ]);
    const evs = (await events(voucher.id)).filter(e => e.type === 'spent' || e.type === 'voided');
    const state = await (await call('GET', '/api/state')).json() as { vouchers: { id: string; status: string; remaining_cents: number }[] };
    const v = state.vouchers.find(x => x.id === voucher.id)!;
    // replay the recorded events and land exactly on the stored row
    let remaining = 2000, status = 'available';
    for (const e of evs) {
      expect(e.previous_remaining_cents).toBe(remaining);
      if (e.type === 'spent') remaining -= 500; else status = 'voided';
    }
    // (also guards void's remaining_cents pin: without it the void records a
    // stale previous_remaining_cents and this replay diverges)
    expect({ remaining, status }).toEqual({ remaining: v.remaining_cents, status: v.status });
  });
});

describe('undo names its action (audit leads 6, 8)', () => {
  it('undoes the caller’s own action', async () => {
    const { voucher } = await addOne();
    await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 500, client_action_id: 'mine' } });
    const r = await call('POST', `/api/vouchers/${voucher.id}/unmark`, { body: { undo_action_id: 'mine' } });
    expect(r.status).toBe(200);
    expect((await r.json() as { voucher: { remaining_cents: number } }).voucher.remaining_cents).toBe(2000);
  });

  it('never rolls back someone else’s later change', async () => {
    const { voucher } = await addOne();
    await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 500, client_action_id: 'alice-spend' } });
    await call('POST', `/api/vouchers/${voucher.id}/use`, { body: { client_action_id: 'bob-use' }, email: BOB });
    const r = await call('POST', `/api/vouchers/${voucher.id}/unmark`, { body: { undo_action_id: 'alice-spend' } });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ reason: 'changed_since', changed_by: BOB });
    const state = await (await call('GET', '/api/state')).json() as { vouchers: { id: string; status: string; used_by: string }[] };
    expect(state.vouchers.find(x => x.id === voucher.id)).toMatchObject({ status: 'used', used_by: BOB });
  });

  it('an Undo of an action that was refused undoes nothing', async () => {
    const { voucher } = await addOne();
    await call('POST', `/api/vouchers/${voucher.id}/use`, { body: { client_action_id: 'bob-first' }, email: BOB });
    const refused = await call('POST', `/api/vouchers/${voucher.id}/use`, { body: { client_action_id: 'alice-late' } });
    expect(refused.status).toBe(409);
    const r = await call('POST', `/api/vouchers/${voucher.id}/unmark`, { body: { undo_action_id: 'alice-late' } });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ reason: 'not_applied' });
  });

  it('an undo cannot be undone again', async () => {
    const { voucher } = await addOne();
    await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 500 } });
    await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 700 } });
    expect((await call('POST', `/api/vouchers/${voucher.id}/unmark`, {})).status).toBe(200);
    const again = await call('POST', `/api/vouchers/${voucher.id}/unmark`, {});
    expect(again.status).toBe(409);
  });
});

describe('scan_failed', () => {
  it('logs an event without changing state', async () => {
    const { voucher } = await addOne();
    const r = await call('POST', `/api/vouchers/${voucher.id}/scan_failed`, {});
    expect(r.status).toBe(200);
    const state = await (await call('GET', '/api/state')).json() as { vouchers: { id: string; status: string; remaining_cents: number }[] };
    const v = state.vouchers.find(x => x.id === voucher.id)!;
    expect(v).toMatchObject({ status: 'available', remaining_cents: 2000 });
    const events = await (await call('GET', `/api/vouchers/${voucher.id}/events`)).json() as { events: { type: string }[] };
    expect(events.events.map(e => e.type)).toEqual(['added', 'scan_failed']);
  });
});

describe('cross-site requests (audit leads 2, 3)', () => {
  const add = (headers: Record<string, string>) =>
    call('POST', '/api/vouchers', { body: [makeVoucher()], headers });

  it('refuses a write another site sent', async () => {
    expect((await add({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await add({ 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    // older browsers: Origin only
    expect((await add({ Origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await add({ Origin: 'null' })).status).toBe(403);
  });

  it('allows the app’s own writes', async () => {
    expect((await add({ 'Sec-Fetch-Site': 'same-origin', Origin: 'http://localhost' })).status).toBe(200);
    expect((await add({ Origin: 'http://localhost' })).status).toBe(200);
  });

  it('checks before auth, so a forged write never reaches a handler', async () => {
    const res = await call('POST', '/api/export', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(res.status).toBe(403);
  });

  it('export no longer answers GET, so a link or <img> cannot reset the backup reminder', async () => {
    const before = await (await call('GET', '/api/state')).json() as { last_export_at: string | null };
    expect((await call('GET', '/api/export')).status).toBe(404);
    const after = await (await call('GET', '/api/state')).json() as { last_export_at: string | null };
    expect(after.last_export_at).toBe(before.last_export_at);
  });
});

describe('original image + export', () => {
  it('stores and serves the original barcode PNG', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);
    const b64 = btoa(String.fromCharCode(...pngBytes));
    const { voucher } = await addOne({ barcode_png_b64: b64 });
    const r = await call('GET', `/api/vouchers/${voucher.id}/original.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(pngBytes);
  });

  it('export dumps everything and sets last_export_at', async () => {
    const png = btoa('fake-png-bytes');
    const { voucher } = await addOne({ barcode_png_b64: png });
    await call('POST', `/api/vouchers/${voucher.id}/spend`, { body: { used_cents: 100 } });
    const before = await (await call('GET', '/api/state')).json() as { last_export_at: string | null };
    const r = await call('POST', '/api/export');
    expect(r.status).toBe(200);
    const dump = await r.json() as { exported_at: string; vouchers: { id: string; barcode_png: string | null }[]; events: unknown[]; gtin_amounts: unknown[] };
    expect(dump.vouchers.length).toBeGreaterThan(0);
    expect(dump.events.length).toBeGreaterThan(0);
    expect(dump.vouchers.find(v => v.id === voucher.id)?.barcode_png).toBe(png);
    const after = await (await call('GET', '/api/state')).json() as { last_export_at: string | null };
    expect(after.last_export_at).toBe(dump.exported_at);
    expect(after.last_export_at).not.toBe(before.last_export_at);
  });
});
