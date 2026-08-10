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
    // Apple's MPEG-4 variant. Every other layer already treats m4v as
    // supported (MIME_TO_EXT maps it, DocumentItemDto.fileType accepts 'm4v',
    // and the web picker offers .m4v) — omitting it here meant a browser that
    // reported video/x-m4v got a hard 400 at the signed-URL step, while the
    // same file reported as video/mp4 uploaded fine. Requires 'video/x-m4v' in
    // the documents bucket's allowed_mime_types too (db/storage-limits.sql).
    'video/x-m4v',
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
