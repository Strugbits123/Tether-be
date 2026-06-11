import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export enum RmRelationshipType {
  FAMILY = 'family',
  FRIEND = 'friend',
  PARTNER = 'partner',
  ATTORNEY = 'attorney',
  COLLEAGUE = 'colleague',
  OTHER = 'other',
}

export class CreateReleaseManagerDto {
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
  @IsEnum(RmRelationshipType)
  relationship: RmRelationshipType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
