import { randomBytes } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const file = resolve(root, '.env');
try { await access(file); console.log('Backend .env exists; kept unchanged.'); }
catch {
  let template = await readFile(resolve(root, '.env.example'), 'utf8');
  template = template.replace('ADMIN_PASSWORD=CHANGE_ME', `ADMIN_PASSWORD=${randomBytes(16).toString('base64url')}`)
    .replace('SESSION_SECRET=CHANGE_ME', `SESSION_SECRET=${randomBytes(32).toString('hex')}`)
    .replace('TOKEN_ENCRYPTION_KEY=CHANGE_ME', `TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`)
    .replace('INGEST_SECRET=CHANGE_ME', `INGEST_SECRET=${randomBytes(32).toString('hex')}`);
  await writeFile(file, template, { mode: 0o600 });
  console.log('Created backend .env. Login email: admin@example.com; password is in that file.');
}
