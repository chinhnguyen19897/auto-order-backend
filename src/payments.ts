import {Injectable, BadRequestException} from '@nestjs/common';
import {PayOS} from '@payos/node';
import QRCode from 'qrcode';
import {env} from './config.ts';

@Injectable()
export class PaymentGateway {
  private client = env.PAYMENT_PROVIDER === 'payos' ? new PayOS({
    clientId: env.PAYOS_CLIENT_ID,
    apiKey: env.PAYOS_API_KEY,
    checksumKey: env.PAYOS_CHECKSUM_KEY,
    timeout: 15000,
    maxRetries: 0
  }) : null;

  async create(input: { orderCode: number; amount: number; code: string; token: string; expiresAt: Date }) {
    if (!this.client) return {
      paymentLinkId: `demo-${input.orderCode}`, checkoutUrl: null,
      qrCode: `AUTO-ORDER-DEMO:${input.orderCode}:${input.amount}:NOT-A-BANK-QR`
    };
    const returnUrl = `${env.WEB_URL}/checkout/${input.token}`;
    try {
      return await this.client.paymentRequests.create({
        orderCode: input.orderCode,
        amount: input.amount,
        description: input.code.slice(0, 25),
        returnUrl,
        cancelUrl: returnUrl,
        expiredAt: Math.floor(input.expiresAt.getTime() / 1000)
      });
    } catch (error) {
      // A timeout can mean the bank link exists: recover using the same orderCode.
      try {
        const existing = await this.client.paymentRequests.get(input.orderCode);
        if (existing.status === 'PENDING') {
          // SDK get does not return QR data. An idempotent create for this orderCode
          // can be retried by operations after investigating; never create another code.
          throw new Error('Payment exists upstream but its QR response was lost; staff reconciliation required.');
        }
      } catch (recovery) {
        if (recovery instanceof Error && recovery.message.startsWith('Payment exists upstream')) throw recovery;
      }
      throw error;
    }
  }

  async verify(body: unknown) {
    if (!this.client) throw new BadRequestException('Real webhook disabled in demo mode.');
    // SDK validates provider-specific canonicalization and HMAC, not browser input.
    try {
      return await this.client.webhooks.verify(body as Parameters<PayOS['webhooks']['verify']>[0]);
    } catch {
      throw new BadRequestException('Invalid payment webhook signature.');
    }
  }

  async cancel(orderCode: number) {
    if (this.client) {
      const result = await this.client.paymentRequests.cancel(orderCode, 'Order reservation expired');
      if (!['CANCELLED', 'EXPIRED'].includes(result.status)) throw new Error('Payment was not cancelled; reconcile before releasing stock.');
    }
  }

  async inspect(orderCode: number) {
    return this.client ? this.client.paymentRequests.get(orderCode) : null;
  }

  async image(qrData: string | null) {
    return qrData ? QRCode.toDataURL(qrData, {width: 320, margin: 2, errorCorrectionLevel: 'M'}) : null;
  }
}
