import { timingSafeEqual } from 'crypto';
import {
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';

// Receives Supabase auth Database Webhooks. Configure in the Supabase
// dashboard: Database → Webhooks → new webhook on `auth.users` UPDATE,
// POSTing to `${API_URL}/api/v1/webhooks/supabase-auth` with header
// `x-webhook-secret: <SUPABASE_WEBHOOK_SECRET>`.
@Controller('webhooks')
@UseGuards(ThrottlerGuard)
export class AuthWebhookController {
  constructor(private readonly authService: AuthService) {}

  @Post('supabase-auth')
  @HttpCode(200)
  handleSupabaseAuthWebhook(@Req() req: Request) {
    const secret = process.env.SUPABASE_WEBHOOK_SECRET;
    if (!secret) {
      throw new ServiceUnavailableException(
        'Supabase webhook secret not configured',
      );
    }

    const provided = req.headers['x-webhook-secret'];
    if (typeof provided !== 'string' || !safeEqual(provided, secret)) {
      throw new ForbiddenException('Invalid webhook secret');
    }

    this.authService.handleEmailVerified(
      (req.body ?? {}) as Parameters<AuthService['handleEmailVerified']>[0],
    );

    return { received: true };
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
