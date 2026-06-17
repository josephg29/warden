import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const dataDir = process.env.DATA_DIR ?? path.join(projectRoot, 'data');
const mcServerDir = path.join(dataDir, 'minecraft-server');

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8080),
  dataDir,
  publicDir: path.join(projectRoot, 'public'),
  msaCacheDir: path.join(dataDir, 'msa-cache'),
  mcServerDir,
  mcServerJar: path.join(mcServerDir, 'server.jar'),
  cerebrasApiKey: process.env.CEREBRAS_API_KEY ?? null,
  // deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? null, // legacy, kept for A/B
};
