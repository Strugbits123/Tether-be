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

  // Slots are 1..MAX_GUARDIANS (guardians.service.ts).
  @IsOptional()
  @IsIn([1, 2])
  guardianOrder?: number;
}
