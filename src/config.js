import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* keine .env vorhanden */ }

function loadJson(name) {
  const file = path.join(ROOT, 'config', `${name}.json`);
  const example = path.join(ROOT, 'config', `${name}.example.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  console.warn(`[config] config/${name}.json fehlt – verwende ${name}.example.json`);
  return JSON.parse(fs.readFileSync(example, 'utf8'));
}

const env = process.env;

export function loadConfig() {
  return {
    port: Number(env.PORT || 3000),
    publicUrl: env.PUBLIC_URL || '',
    sessionSecret: env.SESSION_SECRET || 'dev-secret-nicht-produktiv-nutzen',
    dbFile: path.resolve(ROOT, env.DB_FILE || './data/kundendialog.db'),
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE || '49',
    whatsapp: {
      token: env.WHATSAPP_TOKEN || '',
      appSecret: env.WHATSAPP_APP_SECRET || '',
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
      apiVersion: env.WHATSAPP_API_VERSION || 'v23.0',
      dryRun: env.DRY_RUN !== 'false',
    },
    branches: loadJson('branches'),
    akuwin: loadJson('akuwin'),
    automations: loadJson('automations'),
  };
}
