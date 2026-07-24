import { Module } from '@nestjs/common';
import { GuardiansModule } from '../guardians/guardians.module.js';
import { ResendWebhookController } from './resend-webhook.controller.js';
import { ResendWebhookService } from './resend-webhook.service.js';

@Module({
  imports: [GuardiansModule],
  controllers: [ResendWebhookController],
  providers: [ResendWebhookService],
})
export class ResendWebhookModule {}
