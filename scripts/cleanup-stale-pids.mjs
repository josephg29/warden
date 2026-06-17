#!/usr/bin/env node
// OVN-016: scan data/overnight for *.pid files whose pid is dead, remove them.
// Safe to run on boot or any time the operator suspects stale pid files are
// confusing tooling. Exits 0 always (best-effort cleanup).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStalePids } from './supervisor.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');

const dataDir = process.env.DATA_DIR ?? path.join(REPO_ROOT, 'data');
const overnightDir = path.join(dataDir, 'overnight');

const removed = await cleanupStalePids(overnightDir);
if (removed.length === 0) {
  console.log(`[clean-pids] no stale pid files in ${overnightDir}`);
} else {
  console.log(`[clean-pids] removed ${removed.length} stale pid file(s):`);
  for (const r of removed) {
    console.log(`  ${path.basename(r.file)} (pid=${r.pid ?? 'n/a'}, ${r.reason})`);
  }
}
