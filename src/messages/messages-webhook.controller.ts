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
import { Request } from 'express';
import Mux from '@mux/mux-node';
import { MessagesService } from './messages.service.js';

// Mux's static-rendition lifecycle events mapped to the state we cache.
// 'deleted' is treated as unknown-again rather than a terminal state: the
// rendition can be re-requested, so listVideos should ask Mux next time.
const STATIC_RENDITION_STATUS: Record<
  string,
  'preparing' | 'ready' | 'errored' | 'skipped'
> = {
  'video.asset.static_rendition.created': 'preparing',
  'video.asset.static_rendition.ready': 'ready',
  'video.asset.static_rendition.errored': 'errored',
  'video.asset.static_rendition.skipped': 'skipped',
};

@Controller('webhooks')
@UseGuards(ThrottlerGuard)
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
    } else {
      // Static-rendition lifecycle: cached on the message so the RM video
      // download page doesn't have to ask Mux about every video on every load.
      const renditionStatus = STATIC_RENDITION_STATUS[eventType];
      if (renditionStatus) {
        await this.messagesService.handleMuxStaticRenditionEvent(event, renditionStatus);
      }
    }

    return { received: true };
  }
}
