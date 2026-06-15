import { IsEnum } from 'class-validator';

export enum ImageMimeType {
  JPEG = 'image/jpeg',
  PNG = 'image/png',
  WEBP = 'image/webp',
  HEIC = 'image/heic',
}

export class AvatarUploadDto {
  @IsEnum(ImageMimeType)
  fileType: ImageMimeType;
}
