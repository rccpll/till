// Test auth: a runtime-generated RSA keypair stands in for Cloudflare Access.
// The app verifies tokens against CF_ACCESS_JWKS (local JWKS escape hatch),
// exercising the full jose verification path including issuer+audience pinning.
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { env } from 'cloudflare:test';
import app from '../server/app';
import type { Env } from '../server/env';

export const TEAM_DOMAIN = 'https://till-test.cloudflareaccess.com';
export const AUD = 'test-aud-tag';
export const ALICE = 'alice@example.com';
export const BOB = 'bob@example.com';

const keys = await generateKeyPair('RS256');
const publicJwk = await exportJWK(keys.publicKey);
publicJwk.alg = 'RS256';

export const testEnv: Env = {
  DB: env.DB,
  CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  CF_ACCESS_AUD: AUD,
  CF_ACCESS_JWKS: JSON.stringify({ keys: [publicJwk] }),
};

export async function tokenFor(email: string, opts: { aud?: string; iss?: string } = {}) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(opts.iss ?? TEAM_DOMAIN)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(keys.privateKey);
}

export async function call(
  method: string,
  path: string,
  opts: { body?: unknown; email?: string; token?: string | null } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = opts.token === undefined ? await tokenFor(opts.email ?? ALICE) : opts.token;
  if (token !== null) headers['Cf-Access-Jwt-Assertion'] = token;
  const res = await app.request(path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }, testEnv);
  return res;
}

let codeCounter = 0;

/** A synthetic, structurally valid (01)(21) voucher row. */
export function makeVoucher(overrides: Partial<Record<string, unknown>> = {}) {
  const serial = String(++codeCounter).padStart(16, '0');
  const gtin = '00000000000000';
  return {
    code: `01${gtin}21${serial}`,
    gtin,
    gs1_serial: serial,
    printed_serial: `P${serial}`,
    face_value_cents: 2000,
    expires_at: '2027-11-28',
    issuer: 'coop',
    ...overrides,
  };
}

export async function addOne(overrides: Partial<Record<string, unknown>> = {}) {
  const row = makeVoucher(overrides);
  const res = await call('POST', '/api/vouchers', { body: [row] });
  const json = await res.json() as { added: { id: string }[] };
  return { row, voucher: json.added[0], res };
}
