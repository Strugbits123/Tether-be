import { IsInt, Max, Min } from 'class-validator';

export class ConfirmUploadDto {
  // Browsers can't always measure duration for streamed/webm recordings and
  // send 0 — accept it rather than blocking the upload confirmation.
  @IsInt()
  @Min(0)
  @Max(600)
  durationSeconds: number;

  @IsInt()
  @Min(1)
  @Max(524288000)
  fileSizeBytes: number;
}
