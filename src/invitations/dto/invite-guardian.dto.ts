import {
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { InvitationRelationshipType } from './invite-release-manager.dto.js';
import { GUARDIAN_SLOT_VALUES } from '../../guardians/guardians.constants.js';

export class InviteGuardianDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  name: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsNotEmpty()
  @IsEnum(InvitationRelationshipType)
  relationship: InvitationRelationshipType;

  // Same shared slot values as DesignateGuardianDto.
  @IsOptional()
  @IsIn(GUARDIAN_SLOT_VALUES)
  guardianOrder?: number;
}
