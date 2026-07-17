import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PhotosService } from './photos.service.js';
import { RequestUploadUrlsDto } from './dto/request-upload-urls.dto.js';
import { CreatePhotosBatchDto } from './dto/create-photos-batch.dto.js';
import { CreateFolderDto } from './dto/create-folder.dto.js';
import { UpdateFolderDto } from './dto/update-folder.dto.js';
import { UpdatePhotoDto } from './dto/update-photo.dto.js';
import { MovePhotoDto } from './dto/move-photo.dto.js';

@Controller('photos')
@UseGuards(JwtAuthGuard)
export class PhotosController {
  constructor(private readonly photosService: PhotosService) {}

  @Post('upload-urls')
  getUploadUrls(@Request() req: any, @Body() dto: RequestUploadUrlsDto) {
    return this.photosService.getUploadUrls(req.user.id, dto.files);
  }

  @Post('batch')
  createBatch(@Request() req: any, @Body() dto: CreatePhotosBatchDto) {
    return this.photosService.createBatch(req.user.id, dto);
  }

  @Post('folders')
  createFolder(@Request() req: any, @Body() dto: CreateFolderDto) {
    return this.photosService.createFolder(req.user.id, dto);
  }

  @Get('folders')
  listFolders(@Request() req: any) {
    return this.photosService.listFolders(req.user.id);
  }

  @Patch('folders/:id')
  updateFolder(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateFolderDto,
  ) {
    return this.photosService.updateFolder(req.user.id, id, dto);
  }

  @Delete('folders/:id')
  deleteFolder(@Request() req: any, @Param('id') id: string) {
    return this.photosService.deleteFolder(req.user.id, id);
  }

  @Get()
  listPhotos(@Request() req: any, @Query('folder_id') folderId?: string) {
    return this.photosService.listPhotos(req.user.id, folderId);
  }

  @Get(':id/download-url')
  getDownloadUrl(@Request() req: any, @Param('id') id: string) {
    return this.photosService.getDownloadUrl(req.user.id, id);
  }

  @Get(':id')
  getPhoto(@Request() req: any, @Param('id') id: string) {
    return this.photosService.getPhoto(req.user.id, id);
  }

  @Patch(':id/move')
  movePhoto(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: MovePhotoDto,
  ) {
    return this.photosService.movePhoto(req.user.id, id, dto);
  }

  @Patch(':id')
  updatePhoto(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdatePhotoDto,
  ) {
    return this.photosService.updatePhoto(req.user.id, id, dto);
  }

  @Delete(':id')
  deletePhoto(@Request() req: any, @Param('id') id: string) {
    return this.photosService.deletePhoto(req.user.id, id);
  }
}
