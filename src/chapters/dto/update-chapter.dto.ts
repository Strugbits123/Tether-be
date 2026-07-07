import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';
import { CHAPTER_THEMES } from './create-chapter.dto.js';

export class UpdateChapterDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  date_label?: string;

  @IsOptional()
  @IsIn(CHAPTER_THEMES)
  theme?: string;

  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  word_count?: number;

  @IsOptional()
  @IsIn(['draft', 'in_progress', 'complete'])
  status?: string;
}
