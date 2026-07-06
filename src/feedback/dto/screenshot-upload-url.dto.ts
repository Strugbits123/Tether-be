import { IsIn, IsInt, IsNotEmpty, IsString, Max, MaxLength, Min } from 'class-validator';

export class ScreenshotUploadUrlDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  file_name: string;

  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  file_type: string;

  @IsInt()
  @Min(1)
  @Max(5242880)
  file_size_bytes: number;
}
