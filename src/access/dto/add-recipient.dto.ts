import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { RelationshipType } from '../../recipients/dto/create-recipient.dto.js';

export class AddRecipientDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  first_name: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  last_name: string;

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
  @IsBoolean()
  designate_as_guardian?: boolean;
}
