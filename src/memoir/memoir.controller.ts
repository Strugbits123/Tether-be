import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { MemoirService } from './memoir.service.js';
import { UpdateMemoirDto } from './dto/update-memoir.dto.js';
import { DeleteMemoirDto } from './dto/delete-memoir.dto.js';
import { GenerateTtsDto } from './dto/generate-tts.dto.js';

@Controller('memoir')
@UseGuards(JwtAuthGuard)
export class MemoirController {
  constructor(private readonly memoirService: MemoirService) {}

  @Get()
  getMemoir(@Request() req: any) {
    return this.memoirService.getMemoir(req.user.id);
  }

  @Patch()
  updateMemoir(@Request() req: any, @Body() dto: UpdateMemoirDto) {
    return this.memoirService.updateMemoir(req.user.id, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  deleteMemoir(@Request() req: any, @Body() dto: DeleteMemoirDto) {
    return this.memoirService.deleteMemoir(req.user.id, dto);
  }

  @Get('preview')
  getPreview(@Request() req: any) {
    return this.memoirService.getPreview(req.user.id);
  }

  @Get('download/pdf')
  async downloadPdf(@Request() req: any, @Res() res: Response) {
    const { buffer, filename } = await this.memoirService.downloadPdf(
      req.user.id,
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }

  @Get('download/text')
  async downloadText(@Request() req: any, @Res() res: Response) {
    const { text, filename } = await this.memoirService.downloadText(
      req.user.id,
    );
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(text);
  }

  // Must be before :id routes
  @Get('tts/status')
  getBatchTtsStatus(@Request() req: any) {
    return this.memoirService.getBatchTtsStatus(req.user.id);
  }

  @Post('chapters/:id/tts')
  @HttpCode(HttpStatus.ACCEPTED)
  startTts(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: GenerateTtsDto,
  ) {
    return this.memoirService.startTts(req.user.id, id, dto);
  }

  @Get('chapters/:id/tts')
  getTtsStatus(@Request() req: any, @Param('id') id: string) {
    return this.memoirService.getTtsStatus(req.user.id, id);
  }

  @Delete('chapters/:id/tts')
  @HttpCode(HttpStatus.OK)
  deleteTts(@Request() req: any, @Param('id') id: string) {
    return this.memoirService.deleteTts(req.user.id, id);
  }
}
