import 'dotenv/config';
import {z} from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),
  WEB_URL: z.string().url(),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(12),
  SESSION_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(40),
  INGEST_SECRET: z.string().min(32),
  DEMO_MODE: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  PAYMENT_PROVIDER: z.enum(['demo', 'payos']).default('demo'),
  NOTIFICATION_PROVIDER: z.enum(['demo', 'webhook']).default('demo'),
  PAYOS_CLIENT_ID: z.string().default(''),
  PAYOS_API_KEY: z.string().default(''),
  PAYOS_CHECKSUM_KEY: z.string().default(''),
  NOTIFICATION_WEBHOOK_URL: z.string().default(''),
  NOTIFICATION_WEBHOOK_SECRET: z.string().default(''),
  TIKTOK_SIGN_API_KEY: z.string().default(''),
});
export const env = schema.parse(process.env);
if (Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64').length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must encode 32 bytes');
if ([env.ADMIN_PASSWORD, env.SESSION_SECRET, env.INGEST_SECRET].some(v => v.includes('CHANGE_ME'))) throw new Error('Run npm run setup and choose secrets.');
if (env.NODE_ENV === 'production' && (env.DEMO_MODE || env.PAYMENT_PROVIDER === 'demo' || env.NOTIFICATION_PROVIDER === 'demo')) throw new Error('Production requires real providers and DEMO_MODE=false.');
if (env.NODE_ENV === 'production' && !env.WEB_URL.startsWith('https://')) throw new Error('Production WEB_URL must use HTTPS.');
if (env.PAYMENT_PROVIDER === 'payos' && (!env.PAYOS_CLIENT_ID || !env.PAYOS_API_KEY || !env.PAYOS_CHECKSUM_KEY)) throw new Error('Missing payOS credentials.');
if (env.NOTIFICATION_PROVIDER === 'webhook' && (!env.NOTIFICATION_WEBHOOK_URL.startsWith('https://') || env.NOTIFICATION_WEBHOOK_SECRET.length < 32)) throw new Error('Configure an HTTPS notification gateway and secret.');
export const redisConnection = (() => {
  const u = new URL(env.REDIS_URL);
  return {
    host: u.hostname, port: Number(u.port || 6379), username: u.username || undefined,
    password: decodeURIComponent(u.password) || undefined, db: Number(u.pathname.slice(1) || 0),
    ...(u.protocol === 'rediss:' ? {tls: {}} : {})
  };
})();
