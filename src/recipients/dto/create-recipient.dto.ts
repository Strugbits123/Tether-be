import {
  IsEmail,
  IsString,
  IsOptional,
  IsBoolean,
  IsDateString,
} from 'class-validator';

export class CreateRecipientDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  relationship: string;

  @IsBoolean()
  @IsOptional()
  is_minor?: boolean;

  @IsDateString()
  @IsOptional()
  date_of_birth?: string;

  @IsEmail()
  @IsOptional()
  custodial_adult_email?: string;
}
