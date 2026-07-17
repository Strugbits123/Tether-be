import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const CHAPTER_THEMES = [
  'childhood',
  'family',
  'career',
  'love',
  'hardship',
  'adventure',
  'faith',
  'friendship',
  'loss',
  'milestone',
] as const;

export class CreateChapterDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  date_label?: string;

  @IsOptional()
  @IsIn(CHAPTER_THEMES)
  theme?: string;
}
