import { Module } from '@nestjs/common';
import { ContentController } from './content.controller.js';
import { ContentService } from './content.service.js';
import { MessagesModule } from '../messages/messages.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { PhotosModule } from '../photos/photos.module.js';

@Module({
  imports: [MessagesModule, DocumentsModule, PhotosModule],
  controllers: [ContentController],
  providers: [ContentService],
})
export class ContentModule {}
