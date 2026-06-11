import { IsInt, Max, Min } from 'class-validator';

export class ConfirmUploadDto {
  @IsInt()
  @Min(1)
  @Max(600)
  durationSeconds: number;

  @IsInt()
  @Min(1)
  fileSizeBytes: number;
}
