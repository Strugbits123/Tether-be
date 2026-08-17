import { Module } from '@nestjs/common';
import { ChaptersController } from './chapters.controller.js';
import { ChaptersService } from './chapters.service.js';
import { RecipientsModule } from '../recipients/recipients.module.js';

@Module({
  imports: [RecipientsModule],
  controllers: [ChaptersController],
  providers: [ChaptersService],
  exports: [ChaptersService],
})
export class ChaptersModule {}
