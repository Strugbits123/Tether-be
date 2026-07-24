import {
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { Webhook } from 'svix';
import { ResendWebhookService } from './resend-webhook.service.js';

// Receives Resend email events (delivered/opened/bounced). Configure in the
// Resend dashboard: Webhooks → new endpoint, POSTing to
// `${API_URL}/api/v1/webhooks/resend`. Resend signs payloads via Svix.
@Controller('webhooks')
@UseGuards(ThrottlerGuard)
export class ResendWebhookController {
  constructor(
    private readonly resendWebhookService: ResendWebhookService,
    private readonly config: ConfigService,
  ) {}

  @Post('resend')
  @HttpCode(200)
  async handleResendWebhook(@Req() req: Request & { rawBody?: Buffer }) {
    const secret = this.config.get<string>('RESEND_WEBHOOK_SECRET');
    if (!secret) {
      throw new ServiceUnavailableException('Resend webhook secret not configured');
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new ForbiddenException('Missing raw body');
    }

    let event: { type: string; data: any };
    try {
      const webhook = new Webhook(secret);
      event = webhook.verify(rawBody.toString(), {
        'svix-id': req.headers['svix-id'] as string,
        'svix-timestamp': req.headers['svix-timestamp'] as string,
        'svix-signature': req.headers['svix-signature'] as string,
      }) as { type: string; data: any };
    } catch {
      throw new ForbiddenException('Invalid webhook signature');
    }

    switch (event.type) {
      case 'email.delivered':
        await this.resendWebhookService.handleDelivered(event.data);
        break;
      case 'email.bounced':
        await this.resendWebhookService.handleBounced(event.data);
        break;
      case 'email.opened':
        await this.resendWebhookService.handleOpened(event.data);
        break;
    }

    return { received: true };
  }
}
