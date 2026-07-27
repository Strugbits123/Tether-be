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

  @IsOptional()
  @IsIn([1, 2, 3])
  guardianOrder?: number;
}
