import {
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Request } from 'express';
import Mux from '@mux/mux-node';
import { MessagesService } from './messages.service.js';

@Controller('webhooks')
export class MessagesWebhookController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post('mux')
  @HttpCode(200)
  async handleMuxWebhook(@Req() req: Request & { rawBody?: Buffer }) {
    const webhookSecret = process.env.MUX_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new ServiceUnavailableException('Mux webhook secret not configured');
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new ForbiddenException('Missing raw body');
    }

    const signature = req.headers['mux-signature'] as string;
    try {
      const mux = new Mux({ webhookSecret });
      mux.webhooks.verifySignature(rawBody.toString(), req.headers as Record<string, string>, webhookSecret);
    } catch {
      throw new ForbiddenException('Invalid webhook signature');
    }

    const event = JSON.parse(rawBody.toString()) as Record<string, unknown>;
    const eventType = event.type as string;

    if (eventType === 'video.asset.ready') {
      await this.messagesService.handleMuxAssetReady(event);
    } else if (eventType === 'video.asset.errored') {
      await this.messagesService.handleMuxAssetErrored(event);
    }

    return { received: true };
  }
}
