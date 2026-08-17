import {
  IsString,
  IsOptional,
  IsEnum,
  IsDateString,
  IsBoolean,
  MaxLength,
} from 'class-validator';

export enum Gender {
  WOMAN = 'woman',
  MAN = 'man',
  NON_BINARY = 'non-binary',
  PREFER_NOT_TO_SAY = 'prefer_not_to_say',
}

export enum AgeGroup {
  GROUP_18_29 = '18-29',
  GROUP_30_44 = '30-44',
  GROUP_45_59 = '45-59',
  GROUP_60_PLUS = '60+',
}

export enum RelationshipStatus {
  SINGLE = 'single',
  MARRIED_PARTNERED = 'married_partnered',
  MARRIED_PARTNERED_CHILDREN = 'married_partnered_children',
  SINGLE_PARENT = 'single_parent',
}

export class UpdateProfileDto {
  @IsString()
  @MaxLength(100)
  first_name: string;

  @IsString()
  @MaxLength(100)
  last_name: string;

  @IsDateString()
  @IsOptional()
  date_of_birth?: string;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  zip_code?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2)
  state?: string;

  @IsEnum(AgeGroup)
  @IsOptional()
  age_group?: AgeGroup;

  @IsEnum(Gender)
  @IsOptional()
  gender?: Gender;

  @IsEnum(RelationshipStatus)
  @IsOptional()
  relationship_status?: RelationshipStatus;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  phone_number?: string;

  @IsString()
  @IsOptional()
  avatar_url?: string;

  @IsBoolean()
  @IsOptional()
  sms_opted_in?: boolean;
}
