import {createHmac, timingSafeEqual, randomBytes, createHash, createCipheriv, createDecipheriv} from 'node:crypto';

export function equalSecret(a: string, b: string) {
  const aa = createHash('sha256').update(a).digest(), bb = createHash('sha256').update(b).digest();
  return timingSafeEqual(aa, bb);
}

export function signSession(secret: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({role: 'admin', exp: now + 8 * 3600_000})).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}

export function verifySession(token: string, secret: string, now = Date.now()) {
  const [p, sig, extra] = token.split('.');
  if (!p || !sig || extra || !equalSecret(sig, createHmac('sha256', secret).update(p).digest('base64url'))) return false;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.role === 'admin' && typeof d.exp === 'number' && d.exp > now;
  } catch {
    return false;
  }
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function encryptToken(token: string, key: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function decryptToken(token: string, key: string) {
  const buffer = Buffer.from(token, 'base64url'),
    decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
}
