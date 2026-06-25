import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export enum RelationshipType {
  FAMILY = 'family',
  FRIEND = 'friend',
  PARTNER = 'partner',
  COLLEAGUE = 'colleague',
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
