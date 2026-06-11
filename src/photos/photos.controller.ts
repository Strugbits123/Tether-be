import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PhotosService } from './photos.service.js';
import { RequestUploadUrlsDto } from './dto/request-upload-urls.dto.js';
import { CreatePhotosBatchDto } from './dto/create-photos-batch.dto.js';

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

  @Get()
  listPhotos(@Request() req: any) {
    return this.photosService.listPhotos(req.user.id);
  }

  @Delete(':id')
  deletePhoto(@Request() req: any, @Param('id') id: string) {
    return this.photosService.deletePhoto(req.user.id, id);
  }
}
