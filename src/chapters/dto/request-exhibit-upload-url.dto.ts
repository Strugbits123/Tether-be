import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const CHAPTER_EXHIBIT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;

export const CHAPTER_EXHIBIT_MAX_BYTES = 10485760; // 10MB

export class RequestExhibitUploadUrlDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  file_name: string;

  @IsIn(CHAPTER_EXHIBIT_MIME_TYPES)
  file_type: string;

  @IsInt()
  @Min(1)
  @Max(CHAPTER_EXHIBIT_MAX_BYTES)
  file_size_bytes: number;
}
