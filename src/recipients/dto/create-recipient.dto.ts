import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// Standardized to three relationships platform-wide; these map 1:1 to the
// assignment groups (family/friends/others). Legacy partner/colleague values
// are migrated to `other` (see db/standardize-relationships.sql).
export enum RelationshipType {
  FAMILY = 'family',
  FRIEND = 'friend',
  OTHER = 'other',
}

export class CreateRecipientDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  firstName: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  lastName: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsNotEmpty()
  @IsEnum(RelationshipType)
  relationship: RelationshipType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
