#!/usr/bin/env node
// Downloads Paper 1.21.4 and sets up the Minecraft server directory.
// Run once: node scripts/setup-server.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const serverDir  = path.join(__dirname, '..', 'data', 'minecraft-server');
const jarPath    = path.join(serverDir, 'server.jar');
const MC_VERSION = '1.21.4';

async function main() {
  await fs.mkdir(serverDir, { recursive: true });

  // check if jar already exists
  try {
    await fs.access(jarPath);
    console.log('server.jar already exists — skipping download.');
    await writeConfigs();
    return;
  } catch { /* not found, download */ }

  // get latest Paper build number
  console.log(`Fetching latest Paper ${MC_VERSION} build...`);
  const buildsRes = await fetch(`https://api.papermc.io/v2/projects/paper/versions/${MC_VERSION}/builds`);
  if (!buildsRes.ok) throw new Error(`Failed to fetch builds: ${buildsRes.status}`);
  const { builds } = await buildsRes.json();
  const latest     = builds.at(-1);
  const build      = latest.build;
  const jarName    = `paper-${MC_VERSION}-${build}.jar`;
  const downloadUrl = `https://api.papermc.io/v2/projects/paper/versions/${MC_VERSION}/builds/${build}/downloads/${jarName}`;

  console.log(`Downloading Paper build #${build}...`);
  const jarRes = await fetch(downloadUrl);
  if (!jarRes.ok) throw new Error(`Download failed: ${jarRes.status}`);

  const total = Number(jarRes.headers.get('content-length') ?? 0);
  let received = 0;
  const chunks = [];
  const reader = jarRes.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) process.stdout.write(`\r  ${Math.round(received / total * 100)}%  (${Math.round(received / 1e6)} MB)`);
  }
  process.stdout.write('\n');

  await fs.writeFile(jarPath, Buffer.concat(chunks));
  console.log(`Saved to ${jarPath}`);

  await writeConfigs();
  console.log('\nDone! Start warden and click [ start server ] in the dashboard.');
}

async function writeConfigs() {
  const eula = path.join(serverDir, 'eula.txt');
  try { await fs.access(eula); } catch {
    await fs.writeFile(eula, '#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\neula=true\n');
    console.log('Wrote eula.txt');
  }

  const props = path.join(serverDir, 'server.properties');
  try { await fs.access(props); } catch {
    await fs.writeFile(props, [
      'online-mode=false',
      'server-port=25565',
      'level-name=world',
      'gamemode=survival',
      'difficulty=normal',
      'spawn-protection=0',
      'max-players=20',
      'view-distance=10',
      'simulation-distance=8',
      '',
    ].join('\n'));
    console.log('Wrote server.properties (online-mode=false)');
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
