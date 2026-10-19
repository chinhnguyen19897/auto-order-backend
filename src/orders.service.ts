import {Injectable, NotFoundException, ConflictException, BadRequestException, GoneException} from '@nestjs/common';
import {Prisma, Order, Product} from '@prisma/client';
import {randomBytes} from 'node:crypto';
import {Db} from './db.ts';
import {env} from './config.ts';
import {parseComment, chooseProduct, amountDue, paymentStatus, maskPhone} from './domain.ts';
import {hashToken, encryptToken, decryptToken} from './security.ts';
import {PaymentGateway} from './payments.ts';
import {commentSchema, detailsSchema, productSchema, sessionSchema, validate, type CommentInput} from './validation.ts';
import {z} from 'zod';
import {orderChecks, workflowStatuses, issueCodes} from './order-workflow.ts';

@Injectable()
export class OrdersService {
  constructor(private db: Db, private gateway: PaymentGateway) {
  }

  async transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await this.db.$transaction(fn, {isolationLevel: Prisma.TransactionIsolationLevel.Serializable});
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2034' || e.code === 'P2002') && i < 3) continue;
        throw e;
      }
    }
  }

  link(order: Pick<Order, 'tokenEncrypted'>) {
    return `${env.WEB_URL}/checkout/${decryptToken(order.tokenEncrypted, env.TOKEN_ENCRYPTION_KEY)}`;
  }

  async dashboard() {
    const [products, sessions, orders, comments, notifications, unmatchedReceipts] = await Promise.all([
      this.db.product.findMany({orderBy: {createdAt: 'desc'}}),
      this.db.liveSession.findMany({orderBy: {createdAt: 'desc'}, take: 30}),
      this.db.order.findMany({include: {product: true, payments: true}, orderBy: {createdAt: 'desc'}, take: 100}),
      this.db.comment.findMany({orderBy: {createdAt: 'desc'}, take: 100}),
      this.db.notification.findMany({orderBy: {createdAt: 'desc'}, take: 100}),
      this.db.unmatchedReceipt.findMany({where: {status: 'UNMATCHED'}, orderBy: {createdAt: 'desc'}, take: 100}),
    ]);
    const totals = await this.db.order.aggregate({_sum: {total: true, amountPaid: true}, _count: true});
    const reviewCount = await this.db.comment.count({where: {status: 'REVIEW'}});
    return {
      products, sessions, comments, notifications, unmatchedReceipts,
      orders: orders.map(({tokenEncrypted, tokenHash, ...order}) => ({
        ...order,
        ...orderChecks(order),
        checkoutUrl: this.link({tokenEncrypted})
      })),
      metrics: {
        orders: totals._count,
        total: totals._sum.total || 0,
        collected: totals._sum.amountPaid || 0,
        review: reviewCount
      },
      config: {
        demo: env.DEMO_MODE,
        paymentProvider: env.PAYMENT_PROVIDER,
        notificationProvider: env.NOTIFICATION_PROVIDER
      }
    };
  }

  async product(input: unknown) {
    return this.db.product.create({data: validate(productSchema, input)});
  }

  async updateProduct(id: string, input: unknown) {
    const data = validate(productSchema, input);
    const {expectedVersion} = validate(z.object({expectedVersion: z.number().int().min(0)}), input);
    const result = await this.db.product.updateMany({
      where: {id, version: expectedVersion},
      data: {...data, version: {increment: 1}}
    });
    if (!result.count) throw new ConflictException('Product changed while you were editing. Reopen it and retry.');
    return this.db.product.findUniqueOrThrow({where: {id}});
  }

  async session(input: unknown) {
    const data = validate(sessionSchema, input);
    if (data.currentProductId && !await this.db.product.findUnique({where: {id: data.currentProductId}})) throw new BadRequestException('Unknown product');
    return this.db.liveSession.create({data: {...data, connectionStatus: env.DEMO_MODE ? 'DEMO' : 'CONNECTING'}});
  }

  async updateSession(id: string, input: unknown) {
    const data = validate(z.object({
      status: z.enum(['ACTIVE', 'CLOSED']).optional(),
      currentProductId: z.string().nullable().optional()
    }), input);
    if (data.currentProductId && !await this.db.product.findUnique({where: {id: data.currentProductId}})) throw new BadRequestException('Unknown product');
    return this.db.liveSession.update({where: {id}, data});
  }

  private async createOrder(tx: Prisma.TransactionClient, commentId: string, input: CommentInput, product: Product, phone: string) {
    const changed = await tx.product.updateMany({
      where: {id: product.id, active: true, stock: {gt: 0}},
      data: {stock: {decrement: 1}, version: {increment: 1}}
    });
    if (!changed.count) {
      await tx.comment.update({where: {id: commentId}, data: {status: 'REVIEW', reason: 'Out of stock.'}});
      return null;
    }
    const token = randomBytes(32).toString('base64url');
    const order = await tx.order.create({
      data: {
        code: 'AO' + randomBytes(5).toString('hex').toUpperCase(),
        sessionId: input.sessionId, commentId, productId: product.id, userId: input.userId, handle: input.handle,
        displayName: input.displayName, phone, total: product.price, deposit: product.deposit,
        tokenHash: hashToken(token), tokenEncrypted: encryptToken(token, env.TOKEN_ENCRYPTION_KEY),
        tokenExpiresAt: new Date(Date.now() + 7 * 86400_000), reservedUntil: new Date(Date.now() + 15 * 60_000)
      }
    });
    await tx.comment.update({where: {id: commentId}, data: {status: 'ORDERED', reason: null}});
    // Transactional outbox: queue downtime cannot lose the notification.
    await tx.notification.create({data: {orderId: order.id, channel: env.NOTIFICATION_PROVIDER}});
    return {id: order.id, code: order.code};
  }

  async ingest(data: unknown) {
    const input = validate(commentSchema, data);
    return this.transaction(async tx => {
      const previous = await tx.comment.findUnique({
        where: {
          sessionId_eventId: {
            sessionId: input.sessionId,
            eventId: input.eventId
          }
        }, include: {order: {select: {id: true, code: true}}}
      });
      if (previous) return {commentId: previous.id, status: previous.status, order: previous.order, replay: true};
      const session = await tx.liveSession.findUnique({where: {id: input.sessionId}});
      if (!session || session.status !== 'ACTIVE') throw new BadRequestException('Session is not active.');
      const timestamp = input.occurredAt ? new Date(input.occurredAt) : new Date();
      if (timestamp.getTime() > Date.now() + 60_000) throw new BadRequestException('Comment timestamp is in the future.');
      const comment = await tx.comment.create({data: {...input, occurredAt: timestamp}});
      const parsed = parseComment(input.text);
      // Ordinary conversation is stored, but does not create an order.
      if (!parsed.sku && parsed.price === null && !parsed.phone && !/[\d].*(?:k|đ|xxxx)|chốt|chot/i.test(input.text)) {
        await tx.comment.update({where: {id: comment.id}, data: {status: 'IGNORED', reason: 'No order information.'}});
        return {commentId: comment.id, status: 'IGNORED'};
      }
      let reason = parsed.reason;
      if (!/^\d+$/.test(input.userId)) reason = 'Stable TikTok user ID unavailable; staff must confirm.';
      if (/\?|kh[oô]ng\s+(?:ch[oố]t|mua)|h[uủ]y|bao nhi[eê]u/i.test(input.text)) reason = 'Question or cancellation; staff must confirm intent.';
      if (Date.now() - timestamp.getTime() > 120_000) reason = 'Delayed comment; staff must confirm the product.';
      const selection = chooseProduct(parsed, await tx.product.findMany(), session.currentProductId);
      reason ||= selection.reason;
      if (reason || !selection.product || !parsed.phone) {
        await tx.comment.update({where: {id: comment.id}, data: {status: 'REVIEW', reason}});
        return {commentId: comment.id, status: 'REVIEW', reason};
      }
      const duplicate = await tx.order.findFirst({
        where: {
          sessionId: input.sessionId,
          userId: input.userId,
          productId: selection.product.id,
          phone: parsed.phone,
          status: {notIn: ['CANCELLED', 'EXPIRED']},
          createdAt: {gt: new Date(Date.now() - 90_000)}
        }
      });
      if (duplicate) {
        await tx.comment.update({
          where: {id: comment.id},
          data: {
            status: 'DUPLICATE',
            reason: `Already captured as ${duplicate.code}; staff can review if this is an additional purchase.`
          }
        });
        return {commentId: comment.id, status: 'DUPLICATE', order: {id: duplicate.id, code: duplicate.code}};
      }
      const order = await this.createOrder(tx, comment.id, input, selection.product, parsed.phone);
      return {commentId: comment.id, status: order ? 'ORDERED' : 'REVIEW', order};
    });
  }

  async resolve(id: string, body: unknown) {
    const data = validate(z.object({
      productId: z.string(),
      phone: z.string().transform(v => parseComment(`1000k - ${v}`).phone).refine(v => v !== null)
    }), body);
    return this.transaction(async tx => {
      const comment = await tx.comment.findUnique({where: {id}});
      if (!comment || !['REVIEW', 'DUPLICATE'].includes(comment.status)) throw new ConflictException('Comment is not available for review.');
      const product = await tx.product.findUnique({where: {id: data.productId}});
      if (!product?.active) throw new BadRequestException('Select an active product.');
      return this.createOrder(tx, id, {...comment, occurredAt: comment.occurredAt.toISOString()}, product, data.phone!);
    });
  }

  async ignore(id: string) {
    return this.db.comment.updateMany({
      where: {id, status: {in: ['REVIEW', 'DUPLICATE']}},
      data: {status: 'IGNORED', reason: 'Dismissed by staff.'}
    });
  }

  async findPublic(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException('Order not found');
    const order = await this.db.order.findUnique({
      where: {tokenHash: hashToken(token)},
      include: {product: true, payments: {orderBy: {createdAt: 'desc'}}}
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.tokenExpiresAt.getTime() < Date.now()) throw new GoneException('This checkout link has expired. Contact the seller.');
    return order;
  }

  async publicOrder(token: string) {
    const order = await this.findPublic(token);
    const pending = order.payments.find(p => p.status === 'PENDING' && p.expiresAt.getTime() > Date.now());
    return {
      code: order.code, product: {name: order.product.name, sku: order.product.sku},
      total: order.total, deposit: order.deposit, amountPaid: order.amountPaid, status: order.status,
      phoneHint: maskPhone(order.phone), customerName: order.customerName, address: order.address,
      reservedUntil: order.reservedUntil, demo: env.PAYMENT_PROVIDER === 'demo',
      payment: pending ? {
        id: pending.id, amount: pending.amount, checkoutUrl: pending.checkoutUrl,
        qrImage: await this.gateway.image(pending.qrData), expiresAt: pending.expiresAt
      } : null
    };
  }

  async details(token: string, input: unknown) {
    const data = validate(detailsSchema, input), order = await this.findPublic(token);
    if (data.phone !== order.phone) throw new BadRequestException('Phone must match the comment; contact staff to correct it.');
    const result = await this.db.order.updateMany({
      where: {id: order.id, status: {in: ['AWAITING_DETAILS', 'AWAITING_PAYMENT']}, reservedUntil: {gt: new Date()}},
      data: {customerName: data.customerName, address: data.address, consentAt: new Date(), status: 'AWAITING_PAYMENT'}
    });
    if (!result.count) throw new ConflictException('Order is expired, cancelled, or already paid.');
    return this.publicOrder(token);
  }

  async createPayment(token: string, body: unknown) {
    const {kind} = validate(z.object({kind: z.enum(['deposit', 'full'])}), body);
    const order = await this.findPublic(token);
    const prepared = await this.transaction(async tx => {
      const current = await tx.order.findUniqueOrThrow({where: {id: order.id}});
      if (!['AWAITING_PAYMENT', 'DEPOSIT_PAID'].includes(current.status) || !current.consentAt) throw new ConflictException('Confirm delivery details before paying.');
      if (current.amountPaid === 0 && current.reservedUntil.getTime() < Date.now()) throw new ConflictException('Reservation expired.');
      const existing = await tx.payment.findFirst({
        where: {
          orderId: order.id,
          status: {in: ['CREATING', 'PENDING', 'RECONCILE']}
        }, orderBy: {createdAt: 'desc'}
      });
      if (existing && existing.expiresAt.getTime() > Date.now()) {
        if (existing.status !== 'PENDING') throw new ConflictException('Payment is being created or needs staff reconciliation.');
        return {payment: existing, existing: true};
      }
      if (existing) throw new ConflictException('Previous payment is expiring; retry after reconciliation.');
      const amount = amountDue(current, kind);
      if (amount < 1000) throw new ConflictException('This payment has already been covered.');
      const expiresAt = new Date(Math.min(Date.now() + 10 * 60_000, current.amountPaid ? Date.now() + 10 * 60_000 : current.reservedUntil.getTime()));
      return {
        payment: await tx.payment.create({
          data: {
            orderId: order.id,
            amount,
            provider: env.PAYMENT_PROVIDER,
            expiresAt
          }
        }), existing: false
      };
    });
    if (!prepared.existing) {
      try {
        const result = await this.gateway.create({
          orderCode: prepared.payment.orderCode, amount: prepared.payment.amount,
          code: order.code, token, expiresAt: prepared.payment.expiresAt
        });
        // A webhook may have already marked it PAID; do not revert that status.
        await this.db.payment.updateMany({
          where: {id: prepared.payment.id, status: 'CREATING'}, data: {
            status: 'PENDING',
            paymentLinkId: result.paymentLinkId,
            checkoutUrl: result.checkoutUrl,
            qrData: result.qrCode
          }
        });
      } catch {
        await this.db.payment.updateMany({
          where: {id: prepared.payment.id, status: 'CREATING'},
          data: {status: 'RECONCILE'}
        });
        throw new ConflictException('Payment provider response uncertain. Staff must reconcile this payment before retrying.');
      }
    }
    return this.publicOrder(token);
  }

  async applyReceipt(input: {
    orderCode: number;
    amount: number;
    reference: string;
    paymentLinkId: string;
    currency: string
  }) {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.currency !== 'VND' || !input.reference) throw new BadRequestException('Invalid payment receipt.');
    return this.transaction(async tx => {
      const prior = await tx.paymentReceipt.findUnique({where: {reference: input.reference}});
      if (prior) return {received: true, duplicate: true};
      const payment = await tx.payment.findUnique({where: {orderCode: input.orderCode}, include: {order: true}});
      if (!payment) {
        await tx.unmatchedReceipt.upsert({where: {reference: input.reference}, update: {}, create: input});
        return {received: true, review: true, unmatched: true};
      }
      if (payment.paymentLinkId && payment.paymentLinkId !== input.paymentLinkId) throw new BadRequestException('Payment link mismatch.');
      await tx.paymentReceipt.create({data: {reference: input.reference, amount: input.amount, paymentId: payment.id}});
      await tx.unmatchedReceipt.updateMany({where: {reference: input.reference}, data: {status: 'MATCHED'}});
      const paid = payment.order.amountPaid + input.amount;
      const needsReview = ['CANCELLED', 'EXPIRED', 'PAYMENT_REVIEW'].includes(payment.order.status) ||
        !['CREATING', 'PENDING', 'RECONCILE'].includes(payment.status) || input.amount !== payment.amount || paid > payment.order.total;
      await tx.payment.update({
        where: {id: payment.id},
        data: {status: needsReview ? 'REVIEW' : 'PAID', paymentLinkId: payment.paymentLinkId || input.paymentLinkId}
      });
      // Late, partial, excess, or repeated transfers remain recorded, but never
      // silently allocate inventory that has already been released.
      await tx.order.update({
        where: {id: payment.orderId}, data: {
          amountPaid: paid,
          status: needsReview ? 'PAYMENT_REVIEW' : paymentStatus(paid, payment.order.total)
        }
      });
      return {received: true, review: needsReview};
    });
  }

  async webhook(body: unknown) {
    const data = await this.gateway.verify(body);
    if (data.code !== '00') return {received: true, ignored: true};
    return this.applyReceipt({
      orderCode: data.orderCode, amount: data.amount, reference: data.reference,
      paymentLinkId: data.paymentLinkId, currency: data.currency
    });
  }

  async demoPayment(token: string) {
    if (!env.DEMO_MODE || env.PAYMENT_PROVIDER !== 'demo') throw new NotFoundException();
    const order = await this.findPublic(token);
    const payment = order.payments.find(p => p.status === 'PENDING' && p.expiresAt.getTime() > Date.now());
    if (!payment) throw new ConflictException('Generate a demo QR first.');
    await this.applyReceipt({
      orderCode: payment.orderCode, amount: payment.amount, reference: `demo-${payment.id}`,
      paymentLinkId: payment.paymentLinkId!, currency: 'VND'
    });
    return this.publicOrder(token);
  }

  async updateChecks(id: string, input: unknown) {
    const data = validate(z.object({
      workflowStatus: z.enum(workflowStatuses),
      zaloContact: z.string().trim().max(200).nullable(),
      issues: z.array(z.enum(issueCodes)).max(issueCodes.length),
      issueNote: z.string().trim().max(1000).nullable()
    }).strict(), input);
    return this.transaction(async tx => {
      const order = await tx.order.findUniqueOrThrow({where: {id}, include: {payments: true}});
      if (['CANCELLED', 'EXPIRED'].includes(order.status)) throw new ConflictException('Inactive orders cannot be checked.');
      if (data.workflowStatus !== 'NEEDS_MATCHING' && !data.zaloContact) throw new BadRequestException('Enter the matched Zalo contact first.');
      if (data.workflowStatus === 'NEEDS_MATCHING' && data.zaloContact) throw new BadRequestException('Select Zalo matched when a contact is provided.');
      const checks = orderChecks({...order, ...data});
      if (['READY', 'CONFIRMED'].includes(data.workflowStatus) && checks.checkIssues.length) throw new ConflictException('Resolve missing customer details, flagged issues and payment reviews before marking this order ready or confirmed.');
      if (data.issues.includes('OTHER') && !data.issueNote) throw new BadRequestException('Describe the other issue in the note.');
      await tx.order.update({where: {id}, data: {...data, issues: [...new Set(data.issues)]}});
      return {updated: true};
    });
  }

  async notify(id: string) {
    const order = await this.db.order.findUniqueOrThrow({where: {id}});
    if (['CANCELLED', 'EXPIRED'].includes(order.status)) throw new ConflictException('Order is inactive.');
    return this.db.notification.create({data: {orderId: id, channel: env.NOTIFICATION_PROVIDER}});
  }

  async reconcile(id: string) {
    const payment = await this.db.payment.findUniqueOrThrow({where: {id}});
    if (!['CREATING', 'RECONCILE', 'PENDING'].includes(payment.status)) throw new ConflictException('This payment needs manual accounting review.');
    const upstream = await this.gateway.inspect(payment.orderCode);
    if (upstream?.transactions.length) {
      for (const transaction of upstream.transactions) await this.applyReceipt({
        orderCode: payment.orderCode,
        amount: transaction.amount, reference: transaction.reference, paymentLinkId: upstream.id, currency: 'VND'
      });
      return {reconciled: true};
    }
    if (upstream && (upstream.amountPaid > 0 || !['PENDING', 'CANCELLED', 'EXPIRED'].includes(upstream.status))) {
      throw new ConflictException('Provider reports an uncertain payment. Check the bank before making changes.');
    }
    // A missing create response is not proof that no money was received.
    // Only an authenticated zero-payment response may be closed and replaced.
    if (!upstream || upstream.status === 'PENDING') await this.gateway.cancel(payment.orderCode);
    await this.db.payment.updateMany({
      where: {id, status: {in: ['CREATING', 'RECONCILE', 'PENDING']}},
      data: {status: 'CANCELLED'}
    });
    return {reconciled: true, note: 'Old payment link closed. Buyer can generate a new link.'};
  }

  async cancel(id: string) {
    // Remote pending links must be cancelled first. Failed cancellations keep
    // the stock held; the expiry sweeper will retry safely.
    const pending = await this.db.payment.findMany({
      where: {
        orderId: id,
        status: {in: ['CREATING', 'PENDING', 'RECONCILE']}
      }
    });
    for (const payment of pending) await this.gateway.cancel(payment.orderCode);
    return this.transaction(async tx => {
      const order = await tx.order.findUniqueOrThrow({where: {id}});
      if (order.amountPaid > 0 || !['AWAITING_DETAILS', 'AWAITING_PAYMENT'].includes(order.status)) throw new ConflictException('Paid/review orders require manual reconciliation.');
      if (order.stockHeld) await tx.product.update({
        where: {id: order.productId},
        data: {stock: {increment: 1}, version: {increment: 1}}
      });
      await tx.order.update({where: {id}, data: {status: 'CANCELLED', stockHeld: false}});
      await tx.payment.updateMany({
        where: {orderId: id, status: {in: ['CREATING', 'PENDING', 'RECONCILE']}},
        data: {status: 'CANCELLED'}
      });
      await tx.notification.updateMany({where: {orderId: id, status: 'QUEUED'}, data: {status: 'CANCELLED'}});
      return {cancelled: true};
    });
  }
}
