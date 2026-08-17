import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CHAPTER_THEMES } from './create-chapter.dto.js';

export class RequestVoiceUploadUrlDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  date_label?: string;

  @IsOptional()
  @IsString()
  @IsIn(CHAPTER_THEMES)
  theme?: string;

  @IsString()
  @IsNotEmpty()
  file_name: string;

  @IsString()
  @IsNotEmpty()
  file_type: string;

  @IsNumber()
  @Min(1)
  @Max(52428800)
  file_size_bytes: number;
}

export class CreateVoiceChapterDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  date_label?: string;

  @IsOptional()
  @IsString()
  @IsIn(CHAPTER_THEMES)
  theme?: string;

  @IsString()
  @IsNotEmpty()
  storage_path: string;

  @IsString()
  @IsNotEmpty()
  file_type: string;

  @IsNumber()
  @Min(1)
  file_size_bytes: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  duration_seconds?: number;
}
