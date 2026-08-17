import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CHAPTER_EXHIBIT_MAX_BYTES } from './request-exhibit-upload-url.dto.js';

export class CreateExhibitDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  file_name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  storage_path: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  file_type?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CHAPTER_EXHIBIT_MAX_BYTES)
  file_size_bytes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;
}
