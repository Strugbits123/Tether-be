import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export enum InvitationRelationshipType {
  FAMILY = 'family',
  FRIEND = 'friend',
  PARTNER = 'partner',
  ATTORNEY = 'attorney',
  COLLEAGUE = 'colleague',
  EXECUTOR = 'executor',
  OTHER = 'other',
}

export class InviteReleaseManagerDto {
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
  @IsString()
  @MaxLength(500)
  note?: string;
}
