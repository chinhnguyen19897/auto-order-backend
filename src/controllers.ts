import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
  NotFoundException
} from '@nestjs/common';
import type {Request, Response} from 'express';
import {z} from 'zod';
import {OrdersService} from './orders.service.ts';
import {AdminGuard} from './auth.ts';
import {env} from './config.ts';
import {equalSecret, signSession} from './security.ts';
import {validate} from './validation.ts';
import {Db} from './db.ts';
import {Throttle} from '@nestjs/throttler';

@Controller('auth')
export class AuthController {
  @Throttle({default: {limit: 10, ttl: 60_000}})
  @Post('login') login(@Body() body: unknown, @Res({passthrough: true}) res: Response) {
    const {email, password} = validate(z.object({email: z.email(), password: z.string().max(200)}), body);
    if (!equalSecret(email.toLowerCase(), env.ADMIN_EMAIL.toLowerCase()) || !equalSecret(password, env.ADMIN_PASSWORD)) throw new UnauthorizedException('Invalid credentials.');
    res.cookie('ao_session', signSession(env.SESSION_SECRET), {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 8 * 3600_000,
      path: '/dashboard'
    });
    return {signedIn: true};
  }

  @Post('logout') logout(@Res({passthrough: true}) res: Response) {
    res.clearCookie('ao_session', {path: '/'});
    return {signedIn: false};
  }
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private orders: OrdersService) {
  }

  @Get('dashboard') dashboard() {
    return this.orders.dashboard();
  }

  @Post('products') product(@Body() b: unknown) {
    return this.orders.product(b);
  }

  @Patch('products/:id') updateProduct(@Param('id') id: string, @Body() b: unknown) {
    return this.orders.updateProduct(id, b);
  }

  @Post('sessions') session(@Body() b: unknown) {
    return this.orders.session(b);
  }

  @Patch('sessions/:id') updateSession(@Param('id') id: string, @Body() b: unknown) {
    return this.orders.updateSession(id, b);
  }

  @Post('comments/demo') demo(@Body() b: unknown) {
    if (!env.DEMO_MODE) throw new NotFoundException();
    return this.orders.ingest(b);
  }

  @Post('comments/:id/resolve') resolve(@Param('id') id: string, @Body() b: unknown) {
    return this.orders.resolve(id, b);
  }

  @Post('comments/:id/ignore') ignore(@Param('id') id: string) {
    return this.orders.ignore(id);
  }

  @Patch('orders/:id/checks') updateChecks(@Param('id') id: string, @Body() b: unknown) {
    return this.orders.updateChecks(id, b);
  }

  @Post('orders/:id/notify') notify(@Param('id') id: string) {
    return this.orders.notify(id);
  }

  @Post('orders/:id/cancel') cancel(@Param('id') id: string) {
    return this.orders.cancel(id);
  }

  @Post('payments/:id/reconcile') reconcile(@Param('id') id: string) {
    return this.orders.reconcile(id);
  }
}

@Controller('checkout')
export class CheckoutController {
  constructor(private orders: OrdersService) {
  }

  @Get(':token') order(@Param('token') token: string) {
    return this.orders.publicOrder(token);
  }

  @Post(':token/details') details(@Param('token') token: string, @Body() b: unknown) {
    return this.orders.details(token, b);
  }

  @Post(':token/payment') payment(@Param('token') token: string, @Body() b: unknown) {
    return this.orders.createPayment(token, b);
  }

  @Post(':token/demo-pay') demo(@Param('token') token: string) {
    return this.orders.demoPayment(token);
  }
}

@Controller()
export class IntegrationController {
  constructor(private orders: OrdersService, private db: Db) {
  }

  @Get('health') async health() {
    await this.db.$queryRaw`SELECT 1`;
    return {status: 'ok'};
  }

  @Post('ingest/comments') ingest(@Req() req: Request, @Body() b: unknown) {
    if (!equalSecret(req.headers.authorization || '', `Bearer ${env.INGEST_SECRET}`)) throw new UnauthorizedException();
    return this.orders.ingest(b);
  }

  @Get('ingest/sessions') sessions(@Req() req: Request) {
    if (!equalSecret(req.headers.authorization || '', `Bearer ${env.INGEST_SECRET}`)) throw new UnauthorizedException();
    return this.db.liveSession.findMany({where: {status: 'ACTIVE'}});
  }

  @Post('ingest/sessions/:id/heartbeat') heartbeat(@Req() req: Request, @Param('id') id: string, @Body() b: unknown) {
    if (!equalSecret(req.headers.authorization || '', `Bearer ${env.INGEST_SECRET}`)) throw new UnauthorizedException();
    const data = validate(z.object({
      connectionStatus: z.enum(['CONNECTED', 'CONNECTING', 'DISCONNECTED', 'DEMO']),
      lastError: z.string().max(200).nullable().default(null)
    }), b);
    return this.db.liveSession.updateMany({where: {id, status: 'ACTIVE'}, data: {...data, heartbeatAt: new Date()}});
  }

  @Post('webhooks/payos') webhook(@Body() b: unknown) {
    return this.orders.webhook(b);
  }
}
