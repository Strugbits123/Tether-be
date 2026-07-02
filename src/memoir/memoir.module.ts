import { Module } from '@nestjs/common';
import { MemoirController } from './memoir.controller.js';
import { MemoirService } from './memoir.service.js';
import { TtsService } from './tts.service.js';
import { PdfService } from './pdf.service.js';

@Module({
  controllers: [MemoirController],
  providers: [MemoirService, TtsService, PdfService],
  exports: [MemoirService],
})
export class MemoirModule {}
