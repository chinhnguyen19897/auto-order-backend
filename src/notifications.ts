import {createHmac} from 'node:crypto';
import {env} from './config.ts';

export type NotificationPayload = { id: string; phone: string; orderCode: string; checkoutUrl: string; amount: number };

/** The gateway adapts this request to an approved Zalo ZBS template or SMS API.
 * It must enforce consent/eligibility and deduplicate using Idempotency-Key.
 * No arbitrary Zalo user lookup, personal-account automation, or TikTok DM. */
export async function deliverNotification(payload: NotificationPayload) {
  if (env.NOTIFICATION_PROVIDER === 'demo') return; // persisted as DEMO, never claimed SENT
  const body = JSON.stringify(payload), timestamp = String(Date.now());
  const signature = createHmac('sha256', env.NOTIFICATION_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  const response = await fetch(env.NOTIFICATION_WEBHOOK_URL, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.id,
      'X-Timestamp': timestamp,
      'X-Signature': signature
    }, body
  });
  if (!response.ok) throw new Error('Notification gateway rejected delivery.');
}
