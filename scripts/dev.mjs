// One-command local dev: `npm run dev`
//  1. regenerates the local auth keypair + token (.dev.vars / .dev-token)
//  2. applies any pending migrations to the local D1
//  3. builds dist once if it's missing (wrangler serves functions from it)
//  4. runs `wrangler pages dev` (API, :8788) and `vite` (UI, :5173) together
// Ctrl-C stops both. Everything here touches ONLY local state.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const email = process.argv[2] ?? 'local@example.com';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log(`[dev] auth token for ${email}`);
run('node', ['scripts/dev-token.mjs', email]);

console.log('[dev] applying local migrations');
run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'till', '--local']);

if (!existsSync('dist/index.html')) {
  console.log('[dev] no dist/ yet — building once');
  run('npx', ['vite', 'build']);
}

const token = (await readFile('.dev-token', 'utf8')).trim();

const children = [];
function start(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => {
    console.log(`[dev] ${name} exited (${code}); shutting down`);
    stop();
  });
  children.push(child);
}

function stop() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

start('api', 'npx', ['wrangler', 'pages', 'dev', 'dist', '--port', '8788']);
start('ui', 'npx', ['vite', '--port', '5173'], { DEV_ACCESS_TOKEN: token });

console.log('\n[dev] wallet:  http://localhost:5173');
console.log('[dev] upload:  http://localhost:5173/upload');
console.log(`[dev] logged in as ${email} (npm run dev -- other@email.com to switch)\n`);
