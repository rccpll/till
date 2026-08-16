// Local dev auth: generates an RSA keypair, writes the public JWKS into
// .dev.vars (read by `wrangler pages dev`) and a signed JWT into .dev-token
// (attached to /api requests by the vite proxy via DEV_ACCESS_TOKEN).
// Both files are gitignored. Production uses real Cloudflare Access instead.
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { writeFile } from 'node:fs/promises';

const TEAM = 'https://till-local.cloudflareaccess.com';
const AUD = 'local-dev-aud';
const EMAIL = process.argv[2] ?? 'local@example.com';

const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const jwk = await exportJWK(publicKey);
jwk.alg = 'RS256';

await writeFile('.dev.vars',
  `CF_ACCESS_TEAM_DOMAIN=${TEAM}\n` +
  `CF_ACCESS_AUD=${AUD}\n` +
  `CF_ACCESS_JWKS=${JSON.stringify({ keys: [jwk] })}\n`);

const token = await new SignJWT({ email: EMAIL })
  .setProtectedHeader({ alg: 'RS256' })
  .setIssuer(TEAM)
  .setAudience(AUD)
  .setIssuedAt()
  .setExpirationTime('12h')
  .sign(privateKey);

await writeFile('.dev-token', token);
console.log(`wrote .dev.vars and .dev-token (email: ${EMAIL}, valid 12h)`);
