import 'reflect-metadata';
import {Module, Catch, ArgumentsHost, HttpException, ExceptionFilter} from '@nestjs/common';
import {APP_GUARD, NestFactory} from '@nestjs/core';
import {ThrottlerGuard, ThrottlerModule} from '@nestjs/throttler';
import helmet from 'helmet';
import {json} from 'express';
import type {Request, Response, NextFunction} from 'express';
import {Prisma} from '@prisma/client';
import {env} from './config.ts';
import {Db} from './db.ts';
import {OrdersService} from './orders.service.ts';
import {PaymentGateway} from './payments.ts';
import {AdminGuard} from './auth.ts';
import {AuthController, AdminController, CheckoutController, IntegrationController} from './controllers.ts';

@Catch()
class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) return res.status(error.getStatus()).json({message: error.message});
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return res.status(404).json({message: 'Record not found.'});
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({message: 'Record already exists.'});
    // Do not log request bodies, phone numbers, checkout tokens, or provider responses.
    console.error('Request failed:', error instanceof Error ? error.name : 'UnknownError', error instanceof Prisma.PrismaClientKnownRequestError ? error.code : '');
    return res.status(500).json({message: 'Unexpected server error. Please retry.'});
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{name: 'default', ttl: 60_000, limit: 180}])],
  controllers: [AuthController, AdminController, CheckoutController, IntegrationController],
  providers: [Db, OrdersService, PaymentGateway, AdminGuard, {provide: APP_GUARD, useClass: ThrottlerGuard}]
})
class AppModule {
}

const app = await NestFactory.create(AppModule, {logger: ['error', 'warn', 'log'], bodyParser: false});
app.use(helmet());
app.use(json({limit: '32kb'}));
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.path.startsWith('/ingest/') && !req.path.startsWith('/webhooks/')) {
    if (req.headers['x-admin-action'] !== '1' || (req.headers.origin && req.headers.origin !== new URL(env.WEB_URL).origin)) return res.status(403).json({message: 'Invalid request origin.'});
  }
  next();
});
app.useGlobalFilters(new ApiErrors());
app.enableShutdownHooks();
await app.listen(env.PORT, '0.0.0.0');
console.log(`Auto Order API listening on ${env.PORT}; demo=${env.DEMO_MODE}`);
