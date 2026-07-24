import { Equals, IsEnum, IsNotEmpty, IsString, MinLength } from 'class-validator';

export enum ReleaseReason {
  DEATH = 'death',
  INCAPACITATED = 'incapacitated',
  EARLY_RELEASE = 'early_release',
  TERMINAL_DIAGNOSIS = 'terminal_diagnosis',
  LEGAL_AUTHORITY = 'legal_authority',
  RM_UNREACHABLE = 'rm_unreachable',
  OTHER = 'other',
}

export class InitiateReleaseDto {
  @IsNotEmpty()
  @IsEnum(ReleaseReason)
  reason: ReleaseReason;

  @IsNotEmpty()
  @IsString()
  @MinLength(100)
  explanation: string;

  @Equals(true, { message: 'confirmation_checked must be true' })
  confirmation_checked: boolean;
}
