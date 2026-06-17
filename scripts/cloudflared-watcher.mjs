#!/usr/bin/env node
// BUG-010: cloudflared quick-tunnel URLs rotate every cloudflared restart.
// Without this watcher, the live page on Vercel goes blank with "TUNNEL DOWN"
// until someone manually edits live.html and redeploys.
//
// This watcher:
//   1. Tails a cloudflared log file (or follows its stdout if --follow-stdout
//      is used in conjunction with `cloudflared … 2>&1 | node watcher.mjs`).
//   2. Greps each line for the random `*.trycloudflare.com` URL cloudflared
//      announces on startup.
//   3. When a NEW URL appears, writes agora-site/tunnel.json and runs
//      `vercel deploy --prod --yes` from agora-site/ so the live page picks
//      it up. Expect ~30-60s of "TUNNEL DOWN" during the rotation.
//
// Flags:
//   --log <path>           Tail this file. Default: cloudflared.log next to script.
//   --follow-stdout        Read URL announcements from stdin instead of a file.
//   --site-dir <path>      Path to agora-site (where vercel.json lives).
//   --no-deploy            Skip the vercel deploy (writes tunnel.json only).
//   --once                 Exit after the first URL detection (test mode).
//
// Usage examples:
//   # most common: watcher tails the log file cloudflared writes
//   node scripts/cloudflared-watcher.mjs --log /tmp/cloudflared.log
//
//   # alternative: pipe cloudflared's combined output through stdin
//   cloudflared tunnel --url http://localhost:8080 2>&1 | \
//     node scripts/cloudflared-watcher.mjs --follow-stdout

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..', '..');

// Cloudflared prints the public URL on stderr in a banner like:
//   |  https://pilot-notification-vincent-section.trycloudflare.com  |
// We accept any *.trycloudflare.com URL on a line.
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

function parseArgs(argv) {
  const out = {
    log:           null,
    followStdout:  false,
    siteDir:       path.join(REPO_ROOT, 'agora-site'),
    deploy:        true,
    once:          false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--log')             out.log = argv[++i];
    else if (a === '--follow-stdout') out.followStdout = true;
    else if (a === '--site-dir')   out.siteDir = path.resolve(argv[++i]);
    else if (a === '--no-deploy')  out.deploy = false;
    else if (a === '--once')       out.once = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(readHelp());
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!out.log && !out.followStdout) {
    out.log = path.join(__dirname, 'cloudflared.log');
  }
  return out;
}

function readHelp() {
  return `cloudflared-watcher: detect quick-tunnel URL rotations and redeploy live.html

  --log <path>           Tail this file (default: scripts/cloudflared.log)
  --follow-stdout        Read from stdin instead
  --site-dir <path>      Path to agora-site (default: <repo>/agora-site)
  --no-deploy            Write tunnel.json only, skip vercel deploy
  --once                 Exit after the first URL detection
`;
}

async function readCurrentEndpoint(siteDir) {
  const file = path.join(siteDir, 'tunnel.json');
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw)?.endpoint ?? null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeTunnelJson(siteDir, endpoint) {
  const file = path.join(siteDir, 'tunnel.json');
  const body = {
    endpoint,
    updatedAt: new Date().toISOString(),
    note: 'Auto-updated by scripts/cloudflared-watcher.mjs. Do not edit by hand unless you intend to override the watcher.',
  };
  await fsp.writeFile(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

function runVercelDeploy(siteDir) {
  return new Promise((resolve, reject) => {
    // npx so we don't require a global vercel install. --yes skips prompts.
    const proc = spawn('npx', ['--yes', 'vercel', 'deploy', '--prod', '--yes'], {
      cwd: siteDir,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: process.platform === 'win32', // npx.cmd on Windows
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`vercel deploy exited ${code}`));
    });
  });
}

async function handleNewUrl(url, opts, state) {
  if (state.lastUrl === url) return;
  const previous = state.lastUrl;
  state.lastUrl = url;
  console.log(`[watcher] ${new Date().toISOString()} new tunnel URL: ${url}${previous ? ` (was ${previous})` : ''}`);

  await writeTunnelJson(opts.siteDir, url);
  console.log(`[watcher] wrote ${path.join(opts.siteDir, 'tunnel.json')}`);

  if (!opts.deploy) {
    console.log('[watcher] --no-deploy set, skipping vercel deploy');
    return;
  }
  try {
    await runVercelDeploy(opts.siteDir);
    console.log('[watcher] vercel deploy --prod completed');
  } catch (err) {
    console.error(`[watcher] vercel deploy failed: ${err.message}`);
    // Keep the watcher running — operator can manually redeploy from the
    // updated tunnel.json without losing the URL detection.
  }
}

function feedLine(line, opts, state) {
  const m = URL_RE.exec(line);
  if (!m) return false;
  const url = m[0];
  // Defer the async work but don't await — keep the line stream draining.
  handleNewUrl(url, opts, state).catch((err) => {
    console.error(`[watcher] handleNewUrl error: ${err.message}`);
  });
  return true;
}

async function tailFile(filePath, opts, state) {
  // Simple polling tail — robust across editors that rotate the file via
  // rename. Re-open if size shrinks or fd is invalidated.
  let position = 0;
  // Start at the *end* of the file so we don't replay yesterday's URL on every
  // watcher start. The first new line cloudflared writes wins.
  try {
    const st = await fsp.stat(filePath);
    position = st.size;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`[watcher] log file ${filePath} doesn't exist yet — waiting`);
      position = 0;
    } else {
      throw err;
    }
  }

  while (true) {
    let st;
    try { st = await fsp.stat(filePath); }
    catch (err) {
      if (err.code === 'ENOENT') {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
    if (st.size < position) {
      // file was truncated/rotated — start over
      position = 0;
    }
    if (st.size > position) {
      const fd = await fsp.open(filePath, 'r');
      const buf = Buffer.alloc(st.size - position);
      await fd.read(buf, 0, buf.length, position);
      await fd.close();
      position = st.size;
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        const matched = feedLine(line, opts, state);
        if (matched && opts.once) return;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function tailStdin(opts, state) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    // Echo so the operator can still see cloudflared's output.
    process.stdout.write(line + '\n');
    const matched = feedLine(line, opts, state);
    if (matched && opts.once) {
      rl.close();
      return;
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const initial = await readCurrentEndpoint(opts.siteDir);
  const state = { lastUrl: initial };
  console.log(`[watcher] starting${initial ? ` (current endpoint: ${initial})` : ''}`);
  console.log(`[watcher] site dir: ${opts.siteDir}`);
  console.log(`[watcher] deploy:   ${opts.deploy ? 'on' : 'off'}`);

  if (opts.followStdout) {
    console.log('[watcher] reading from stdin');
    await tailStdin(opts, state);
  } else {
    console.log(`[watcher] tailing ${opts.log}`);
    await tailFile(opts.log, opts, state);
  }
}

main().catch((err) => {
  console.error('[watcher] crash:', err);
  process.exit(1);
});
