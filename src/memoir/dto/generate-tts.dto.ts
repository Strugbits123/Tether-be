import { IsOptional, IsString, Matches } from 'class-validator';

export class GenerateTtsDto {
  @IsOptional()
  @IsString()
  @Matches(/^aura-2-\w+-[a-z]{2}$/, {
    message:
      'Must be a valid Deepgram Aura-2 voice model (e.g. aura-2-thalia-en)',
  })
  voice_model?: string;
}
