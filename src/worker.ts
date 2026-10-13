import {Queue, Worker} from 'bullmq';
import {createHash} from 'node:crypto';
import {TikTokLiveConnection, WebcastEvent, ControlEvent, type ClientEventMap} from 'tiktok-live-connector';
import {env, redisConnection} from './config.ts';
import {Db} from './db.ts';
import {OrdersService} from './orders.service.ts';
import {PaymentGateway} from './payments.ts';
import {deliverNotification} from './notifications.ts';
import type {CommentInput} from './validation.ts';
import {normalizeTikTokEvent} from './tiktok-event.ts';

const db = new Db();
await db.$connect();
const gateway = new PaymentGateway(), service = new OrdersService(db, gateway);
const events = new Queue<CommentInput>('live-comments', {connection: redisConnection});
const notifications = new Queue<{ id: string }>('notifications', {connection: redisConnection});
const commentWorker = new Worker<CommentInput>('live-comments', async job => service.ingest(job.data), {
  connection: redisConnection,
  concurrency: 4
});
const notificationWorker = new Worker<{ id: string }>('notifications', async job => {
  const record = await db.notification.findUnique({where: {id: job.data.id}, include: {order: true}});
  if (!record || record.status !== 'QUEUED') return;
  if (['CANCELLED', 'EXPIRED'].includes(record.order.status) || (record.order.amountPaid === 0 && record.order.reservedUntil.getTime() < Date.now())) {
    await db.notification.update({where: {id: record.id}, data: {status: 'CANCELLED'}});
    return;
  }
  await db.notification.update({where: {id: record.id}, data: {attempts: {increment: 1}}});
  await deliverNotification({
    id: record.id, phone: record.order.phone, orderCode: record.order.code,
    checkoutUrl: service.link(record.order), amount: record.order.deposit
  });
  await db.notification.update({
    where: {id: record.id},
    data: {status: env.NOTIFICATION_PROVIDER === 'demo' ? 'DEMO' : 'SENT', sentAt: new Date(), lastError: null}
  });
}, {connection: redisConnection, concurrency: 2});
notificationWorker.on('failed', (job) => {
  if (job && job.attemptsMade >= (job.opts.attempts || 1)) void db.notification.updateMany({
    where: {
      id: job.data.id,
      status: 'QUEUED'
    }, data: {status: 'FAILED', lastError: 'Delivery failed; check gateway and resend from dashboard.'}
  }).catch(() => console.error('Could not update failed outbox record; next tick will reconcile it.'));
});
for (const worker of [commentWorker, notificationWorker]) worker.on('error', () => console.error('Queue connection failed; retrying.'));
commentWorker.on('failed', job => {
  if (job && job.attemptsMade >= (job.opts.attempts || 1)) console.error(`Comment job ${job.id} failed; retained in Redis for retry.`);
});
// The connector's typed-emitter default import loses its methods under NodeNext.
// Restore only the documented on() signature, preserving its exported event map.
type LiveConnection = TikTokLiveConnection & {
  on<E extends keyof ClientEventMap>(event: E, handler: ClientEventMap[E]): LiveConnection
};
const connections = new Map<string, {
  client: LiveConnection;
  username: string;
  nextRetry: number;
  connecting: boolean;
  ended: boolean
}>();
let stopping = false, busy = false;

async function tick() {
  if (busy || stopping) return;
  busy = true;
  try {
    const active = await db.liveSession.findMany({where: {status: 'ACTIVE'}});
    for (const [id, item] of connections) {
      if (!active.some(s => s.id === id)) {
        await item.client.disconnect();
        connections.delete(id);
      }
    }
    for (const session of active) {
      if (env.DEMO_MODE) {
        await db.liveSession.updateMany({
          where: {id: session.id, status: 'ACTIVE'},
          data: {connectionStatus: 'DEMO', heartbeatAt: new Date(), lastError: null}
        });
        continue;
      }
      let item = connections.get(session.id);
      if (!item) {
        const client = new TikTokLiveConnection(session.username, {processInitialData: false, ...(env.TIKTOK_SIGN_API_KEY ? {signApiKey: env.TIKTOK_SIGN_API_KEY} : {})}) as LiveConnection;
        item = {client, username: session.username, nextRetry: 0, connecting: false, ended: false};
        connections.set(session.id, item);
        const current = item;
        client.on(WebcastEvent.CHAT, data => {
          const input = normalizeTikTokEvent(session.id, data);
          if (!input) {
            console.error('Skipped incomplete TikTok event.');
            return;
          }
          const jobId = createHash('sha256').update(`${session.id}:${input.eventId}`).digest('hex');
          void events.add('comment', input, {
            jobId,
            attempts: 8,
            backoff: {type: 'exponential', delay: 1000},
            removeOnComplete: {age: 86400},
            removeOnFail: false
          })
            .catch(() => console.error('Redis unavailable: comment was not persisted. Check connection before selling.'));
        });
        client.on(ControlEvent.DISCONNECTED, () => {
          current.nextRetry = Date.now() + 30_000;
        });
        client.on(ControlEvent.ERROR, () => {
          current.nextRetry = Date.now() + 30_000;
        });
        client.on(WebcastEvent.STREAM_END, () => {
          current.ended = true;
        });
      }
      if (!item.client.isConnected && !item.connecting && !item.ended && Date.now() >= item.nextRetry) {
        item.connecting = true;
        const current = item;
        void current.client.connect().catch(() => {
          current.nextRetry = Date.now() + 30_000;
        })
          .finally(() => {
            current.connecting = false;
          });
      }
      await db.liveSession.updateMany({
        where: {id: session.id, status: 'ACTIVE'}, data: {
          connectionStatus: item.client.isConnected ? 'CONNECTED' : item.connecting ? 'CONNECTING' : 'DISCONNECTED',
          heartbeatAt: new Date(),
          lastError: item.ended ? 'Stream ended. Close this session and create a new one for the next LIVE.' : item.client.isConnected || item.connecting ? null : 'Cannot connect to TikTok LIVE. Worker will retry.'
        }
      });
    }
    const outbox = await db.notification.findMany({where: {status: 'QUEUED'}, take: 100, orderBy: {createdAt: 'asc'}});
    for (const record of outbox) {
      const existing = await notifications.getJob(record.id);
      if (existing && await existing.getState() === 'failed') {
        await db.notification.updateMany({
          where: {id: record.id, status: 'QUEUED'},
          data: {status: 'FAILED', lastError: 'Delivery failed; resend after checking the gateway.'}
        });
        continue;
      }
      await notifications.add('deliver', {id: record.id}, {
        jobId: record.id,
        attempts: 5,
        backoff: {type: 'exponential', delay: 5000},
        removeOnComplete: {age: 86400},
        removeOnFail: false
      });
    }
    // Cancel remote links before releasing inventory. A failure holds the stock
    // for safe reconciliation; it does not claim the payment is unpaid.
    const expired = await db.order.findMany({
      where: {
        amountPaid: 0, stockHeld: true,
        status: {in: ['AWAITING_DETAILS', 'AWAITING_PAYMENT']}, reservedUntil: {lte: new Date()}
      }, take: 50
    });
    for (const order of expired) {
      try {
        await service.cancel(order.id);
        await db.order.updateMany({where: {id: order.id, status: 'CANCELLED'}, data: {status: 'EXPIRED'}});
      } catch {
        console.error('Reservation needs payment reconciliation; stock kept reserved.');
      }
    }
    // A deposit-paid order retains its stock; expired balance links may be cancelled.
    const expiredPayments = await db.payment.findMany({
      where: {status: 'PENDING', expiresAt: {lte: new Date()}},
      take: 50
    });
    for (const payment of expiredPayments) {
      try {
        await gateway.cancel(payment.orderCode);
        await db.payment.updateMany({where: {id: payment.id, status: 'PENDING'}, data: {status: 'CANCELLED'}});
      } catch { /* Bank may have received payment: wait for webhook / manual reconciliation. */
      }
    }
  } catch {
    console.error('Worker tick failed; retrying on next tick.');
  } finally {
    busy = false;
  }
}

const interval = setInterval(() => {
  void tick();
}, 5000);
await tick();
console.log(`Auto Order worker started; TikTok mode=${env.DEMO_MODE ? 'demo' : 'live'}`);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  for (const item of connections.values()) await item.client.disconnect();
  await Promise.all([commentWorker.close(), notificationWorker.close()]);
  await Promise.all([events.close(), notifications.close()]);
  await db.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
