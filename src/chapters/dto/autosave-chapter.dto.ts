import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class AutosaveChapterDto {
  @IsString()
  @IsNotEmpty()
  body: string;

  @IsInt()
  @Min(0)
  word_count: number;
}
