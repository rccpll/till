# Till

A private PWA for gift cards. Drop voucher PDFs in on a desktop; show the
barcode at the till from a phone; mark it used. Every action is attributed,
nothing is ever silently lost or double-spent.

- PDFs are parsed **entirely in the browser** (text layer cross-checked
  against the embedded barcode image); only the parsed facts and a small
  barcode crop are stored.
- The barcode renders offline from cached data, regenerated as **GS1-128**
  (FNC1 included — a plain Code 128 may be rejected by the POS).
- Writes queue in IndexedDB while offline and sync with idempotency keys;
  double-use conflicts come back as blocking banners naming who and when.
- Auth is Cloudflare Access (email one-time PIN); the server verifies the
  JWT (issuer and audience pinned) on every call. No accounts, no passwords.

Stack: React + Vite + Tailwind · Hono on Cloudflare Pages Functions · D1 ·
`bwip-js` · `pdfjs-dist` (desktop only) · `zxing-wasm` · `jose`.
Runs entirely on Cloudflare's free tier (no R2 — it requires a card).

## Deployment

1. **Zero Trust**: <https://one.dash.cloudflare.com> → pick a team name →
   **Free** plan. Your team domain is `https://<team>.cloudflareaccess.com`.
2. **D1**: dashboard → Storage & Databases → D1 → Create → `till`. Then
   `npx wrangler login`, create `wrangler.toml` in the repo root (it's
   gitignored — it holds your database id):

   ```toml
   name = "till"
   compatibility_date = "2026-08-01"
   pages_build_output_dir = "dist"

   [[d1_databases]]
   binding = "DB"
   database_name = "till"
   database_id = "<your D1 database id>"
   migrations_dir = "migrations"
   ```

   and run `npm run db:migrate:prod`.
3. **Pages**: Workers & Pages → Create → Pages → connect this repo.
   Build command `npm run build`, output `dist`. After the first deploy:
   Settings → Bindings → Add → D1 → name **`DB`** → database `till`.
4. **Access**: Zero Trust → Access → Applications → Add → Self-hosted:
   domain `<project>.pages.dev`, **session duration: maximum**, policy allowing
   your email(s) via one-time PIN. Turn **off** "Authenticate with
   Cloudflare One Client". Copy the app's **AUD tag**.
   Also: Pages project → Settings → **Preview access → Restrict previews**,
   then tighten the auto-created Access app's policy to the same emails.
5. **Variables** (Pages → Settings → Variables and secrets, Production):
   `CF_ACCESS_TEAM_DOMAIN` = `https://<team>.cloudflareaccess.com`,
   `CF_ACCESS_AUD` = the AUD tag. Redeploy.
6. **Phones**: open `https://<project>.pages.dev` in Safari → log in → Share →
   **Add to Home Screen**. Add vouchers from a desktop at `/upload`.

## Backups

D1's free tier keeps only 7 days of point-in-time recovery. The **Export
backup (JSON)** button on the upload screen downloads everything; the screen
nags when the last export is older than 30 days. The file contains spendable
codes — treat it like cash and never commit it.

## Local development

```bash
npm install
npm run dev
```

That's it — it generates local auth, applies migrations to a local D1
(separate from production), and starts API + UI together. Open
<http://localhost:5173> (wallet) or `/upload`. Frontend edits hot-reload;
API edits (`server/`, `functions/`) rebuild automatically. To act as
another user for conflict testing: `npm run dev -- partner@example.com`.

Local dev needs `wrangler.toml` too (gitignored — template in Deployment
step 2). Before any deploy exists, any placeholder UUID works as the
database id: locally it only names the on-disk SQLite file.

`npm test` runs the API suite against a real D1 (vitest-pool-workers) plus a
node suite that parses a real voucher PDF if one is present in the repo root
(`Voucher_*.pdf`, gitignored; skipped otherwise).
