import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class DocumentFileDescriptorDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string;

  @IsIn([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'image/jpeg',
    'image/png',
    'image/heic',
    // Audio
    'audio/webm',
    'audio/mpeg',
    'audio/mp4',
    'audio/wav',
    'audio/ogg',
    'audio/aac',
    'audio/x-m4a',
    // Video
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-msvideo',
    'video/mpeg',
  ])
  fileType: string;

  @IsInt()
  @Min(1)
  @Max(52428800)
  fileSizeBytes: number;
}

export class RequestUploadUrlsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => DocumentFileDescriptorDto)
  files: DocumentFileDescriptorDto[];
}
