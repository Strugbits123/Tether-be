import { Module } from '@nestjs/common';
import { RecipientsController } from './recipients.controller.js';
import { RecipientsService } from './recipients.service.js';

@Module({
  controllers: [RecipientsController],
  providers: [RecipientsService],
  exports: [RecipientsService],
})
export class RecipientsModule {}
