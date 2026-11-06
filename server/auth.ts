// Cloudflare Access JWT verification.
//
// Every request must carry Cf-Access-Jwt-Assertion. We verify it against the
// team's JWKS, pinning BOTH issuer and audience — without the audience check, a
// token minted for any other Access application on the same team would be
// accepted here. We never trust Cf-Access-Authenticated-User-Email on its own.
import { jwtVerify, createRemoteJWKSet, createLocalJWKSet } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { Env } from './env';

type JWTVerifier = Parameters<typeof jwtVerify>[1];

const remoteJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(env: Env, issuer: string): JWTVerifier {
  // Test escape hatch: a JSON JWKS in CF_ACCESS_JWKS (never set in production)
  // lets tests sign tokens with their own keypair without network access.
  if (env.CF_ACCESS_JWKS) return createLocalJWKSet(JSON.parse(env.CF_ACCESS_JWKS));
  let jwks = remoteJwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    remoteJwksCache.set(issuer, jwks);
  }
  return jwks;
}

export function accessIssuer(env: Env): string {
  const raw = (env.CF_ACCESS_TEAM_DOMAIN ?? '').trim().replace(/\/+$/, '');
  return raw.startsWith('https://') ? raw : `https://${raw}`;
}

/** Verifies the Access JWT and returns the authenticated email, or null. */
export async function verifyAccessJwt(token: string, env: Env): Promise<string | null> {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return null;
  const issuer = accessIssuer(env);
  try {
    const { payload } = await jwtVerify(token, getJwks(env, issuer), {
      issuer,
      audience: env.CF_ACCESS_AUD,
    });
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

/**
 * Hono middleware: 403 for a state-changing request sent by another site.
 *
 * Access authenticates with a cookie the browser attaches on its own, so
 * without this a page elsewhere could POST here as a signed-in user — a plain
 * form post needs no CORS preflight, and the handlers parse any body as JSON.
 * Safe methods pass (they change nothing, and CORS keeps their responses
 * unreadable cross-site). Browsers send Sec-Fetch-Site (or at least Origin)
 * on every POST; a request with neither isn't from a browser, so it carries
 * no ambient cookie to abuse.
 */
export const rejectCrossSite: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next();
  const site = c.req.header('Sec-Fetch-Site');
  const origin = c.req.header('Origin');
  const allowed = site
    ? site === 'same-origin' || site === 'none'
    : origin === undefined || sameHost(origin, c.req.url);
  if (!allowed) return c.json({ error: 'cross-site request refused' }, 403);
  await next();
};

function sameHost(origin: string, url: string): boolean {
  try { return new URL(origin).host === new URL(url).host; } catch { return false; }
}

/** Hono middleware: 403 unless a valid Access JWT is present; sets c.var.actor. */
export const requireAccess: MiddlewareHandler<{ Bindings: Env; Variables: { actor: string } }> =
  async (c, next) => {
    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (!token) return c.json({ error: 'forbidden' }, 403);
    const email = await verifyAccessJwt(token, c.env);
    if (!email) return c.json({ error: 'forbidden' }, 403);
    c.set('actor', email);
    await next();
  };
