import { ArrayNotEmpty, IsArray, IsString, MaxLength } from 'class-validator';

export class SaveOnboardingPurposesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  purposes: string[];
}
