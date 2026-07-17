import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ChaptersService } from './chapters.service.js';
import { CreateChapterDto } from './dto/create-chapter.dto.js';
import { UpdateChapterDto } from './dto/update-chapter.dto.js';
import { AutosaveChapterDto } from './dto/autosave-chapter.dto.js';
import { ReorderChaptersDto } from './dto/reorder-chapters.dto.js';
import { RequestExhibitUploadUrlDto } from './dto/request-exhibit-upload-url.dto.js';
import { CreateExhibitDto } from './dto/create-exhibit.dto.js';
import { SetChapterAssignmentsDto } from './dto/set-chapter-assignments.dto.js';
import {
  CreateVoiceChapterDto,
  RequestVoiceUploadUrlDto,
} from './dto/create-voice-chapter.dto.js';

@Controller('chapters')
@UseGuards(JwtAuthGuard)
export class ChaptersController {
  constructor(private readonly chaptersService: ChaptersService) {}

  @Post()
  createChapter(@Request() req: any, @Body() dto: CreateChapterDto) {
    return this.chaptersService.createChapter(req.user.id, dto);
  }

  @Get()
  listChapters(@Request() req: any) {
    return this.chaptersService.listChapters(req.user.id);
  }

  // Must be registered before ':id' so static paths aren't matched as an id.
  @Patch('reorder')
  reorderChapters(@Request() req: any, @Body() dto: ReorderChaptersDto) {
    return this.chaptersService.reorderChapters(req.user.id, dto);
  }

  @Post('voice/upload-url')
  getVoiceUploadUrl(
    @Request() req: any,
    @Body() dto: RequestVoiceUploadUrlDto,
  ) {
    return this.chaptersService.getVoiceUploadUrl(req.user.id, dto);
  }

  @Post('voice')
  createVoiceChapter(
    @Request() req: any,
    @Body() dto: CreateVoiceChapterDto,
  ) {
    return this.chaptersService.createVoiceChapter(req.user.id, dto);
  }

  @Get(':id')
  getChapter(@Request() req: any, @Param('id') id: string) {
    return this.chaptersService.getChapter(req.user.id, id);
  }

  @Get(':id/transcription')
  getTranscriptionStatus(@Request() req: any, @Param('id') id: string) {
    return this.chaptersService.getTranscriptionStatus(req.user.id, id);
  }

  @Patch(':id')
  updateChapter(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateChapterDto,
  ) {
    return this.chaptersService.updateChapter(req.user.id, id, dto);
  }

  @Patch(':id/autosave')
  autosave(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: AutosaveChapterDto,
  ) {
    return this.chaptersService.autosave(req.user.id, id, dto);
  }

  @Delete(':id')
  deleteChapter(@Request() req: any, @Param('id') id: string) {
    return this.chaptersService.deleteChapter(req.user.id, id);
  }

  @Post(':id/exhibits/upload-url')
  getExhibitUploadUrl(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: RequestExhibitUploadUrlDto,
  ) {
    return this.chaptersService.getExhibitUploadUrl(req.user.id, id, dto);
  }

  @Post(':id/exhibits')
  createExhibit(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: CreateExhibitDto,
  ) {
    return this.chaptersService.createExhibit(req.user.id, id, dto);
  }

  @Get(':id/exhibits')
  listExhibits(@Request() req: any, @Param('id') id: string) {
    return this.chaptersService.listExhibits(req.user.id, id);
  }

  @Delete(':id/exhibits/:exhibitId')
  deleteExhibit(
    @Request() req: any,
    @Param('id') id: string,
    @Param('exhibitId') exhibitId: string,
  ) {
    return this.chaptersService.deleteExhibit(req.user.id, id, exhibitId);
  }

  @Post(':id/assignments')
  setAssignments(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: SetChapterAssignmentsDto,
  ) {
    return this.chaptersService.setAssignments(req.user.id, id, dto);
  }

  @Get(':id/assignments')
  getAssignments(@Request() req: any, @Param('id') id: string) {
    return this.chaptersService.getAssignments(req.user.id, id);
  }
}
