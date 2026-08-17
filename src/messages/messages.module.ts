import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller.js';
import { MessagesWebhookController } from './messages-webhook.controller.js';
import { MessagesService } from './messages.service.js';

@Module({
  controllers: [MessagesController, MessagesWebhookController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
