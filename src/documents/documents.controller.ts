import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { DocumentsService } from './documents.service.js';
import { RequestUploadUrlsDto } from './dto/request-upload-urls.dto.js';
import { CreateDocumentsBatchDto } from './dto/create-documents-batch.dto.js';

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('upload-urls')
  getUploadUrls(@Request() req: any, @Body() dto: RequestUploadUrlsDto) {
    return this.documentsService.getUploadUrls(req.user.id, dto.files);
  }

  @Post('batch')
  createBatch(@Request() req: any, @Body() dto: CreateDocumentsBatchDto) {
    return this.documentsService.createBatch(req.user.id, dto);
  }

  @Get()
  listDocuments(@Request() req: any, @Query('category') category?: string) {
    return this.documentsService.listDocuments(req.user.id, category);
  }

  @Get(':id/download-url')
  getDownloadUrl(@Request() req: any, @Param('id') id: string) {
    return this.documentsService.getDownloadUrl(req.user.id, id);
  }

  @Delete(':id')
  deleteDocument(@Request() req: any, @Param('id') id: string) {
    return this.documentsService.deleteDocument(req.user.id, id);
  }
}
