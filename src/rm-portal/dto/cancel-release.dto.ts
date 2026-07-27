import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CancelReleaseDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(1000)
  reason: string;
}
