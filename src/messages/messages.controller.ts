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
import { MessagesService } from './messages.service.js';
import { CreateTextMessageDto } from './dto/create-text-message.dto.js';
import { CreateVideoMessageDto } from './dto/create-video-message.dto.js';
import { CreateAudioMessageDto } from './dto/create-audio-message.dto.js';
import { ConfirmUploadDto } from './dto/confirm-upload.dto.js';
import { UpdateMessageDto } from './dto/update-message.dto.js';
import { ReorderMessagesDto } from './dto/reorder-messages.dto.js';

@Controller('messages')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post()
  createTextMessage(@Request() req: any, @Body() dto: CreateTextMessageDto) {
    return this.messagesService.createTextMessage(req.user.id, dto);
  }

  @Post('video/upload-url')
  createVideoUploadUrl(
    @Request() req: any,
    @Body() dto: CreateVideoMessageDto,
  ) {
    return this.messagesService.createVideoUploadUrl(req.user.id, dto);
  }

  @Post('audio/upload-url')
  createAudioUploadUrl(
    @Request() req: any,
    @Body() dto: CreateAudioMessageDto,
  ) {
    return this.messagesService.createAudioUploadUrl(req.user.id, dto);
  }

  @Get()
  listMessages(@Request() req: any) {
    return this.messagesService.listMessages(req.user.id);
  }

  // Static sub-routes must be declared before /:id to avoid route collision
  @Patch('reorder')
  reorderMessages(@Request() req: any, @Body() dto: ReorderMessagesDto) {
    return this.messagesService.reorderMessages(req.user.id, dto);
  }

  @Get(':id')
  getMessage(@Request() req: any, @Param('id') id: string) {
    return this.messagesService.getMessage(req.user.id, id);
  }

  @Get(':id/status')
  getMessageStatus(@Request() req: any, @Param('id') id: string) {
    return this.messagesService.getMessageStatus(req.user.id, id);
  }

  @Post(':id/confirm-upload')
  confirmUpload(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.messagesService.confirmUpload(req.user.id, id, dto);
  }

  @Post(':id/playback-token')
  getMuxPlaybackToken(@Request() req: any, @Param('id') id: string) {
    return this.messagesService.getMuxPlaybackToken(req.user.id, id);
  }

  @Post(':id/audio-url')
  getAudioSignedUrl(@Request() req: any, @Param('id') id: string) {
    return this.messagesService.getAudioSignedUrl(req.user.id, id);
  }

  @Patch(':id')
  updateMessage(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateMessageDto,
  ) {
    return this.messagesService.updateMessage(req.user.id, id, dto);
  }

  @Delete(':id')
  deleteMessage(@Request() req: any, @Param('id') id: string) {
    return this.messagesService.deleteMessage(req.user.id, id);
  }
}
