import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class GuardianRequestDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(300)
  explanation: string;
}
