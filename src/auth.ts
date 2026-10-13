import {Injectable, CanActivate, ExecutionContext, UnauthorizedException} from '@nestjs/common';
import type {Request} from 'express';
import {env} from './config.ts';
import {verifySession} from './security.ts';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const token = /(?:^|;\s*)ao_session=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
    if (!verifySession(token, env.SESSION_SECRET)) throw new UnauthorizedException('Sign in to continue.');
    return true;
  }
}
