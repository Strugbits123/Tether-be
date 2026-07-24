import { IsBoolean, IsOptional } from 'class-validator';

export class PrepareDownloadDto {
  @IsOptional()
  @IsBoolean()
  audio?: boolean;

  @IsOptional()
  @IsBoolean()
  documents?: boolean;

  @IsOptional()
  @IsBoolean()
  photos?: boolean;

  @IsOptional()
  @IsBoolean()
  transcripts?: boolean;

  @IsOptional()
  @IsBoolean()
  life_story?: boolean;
}
