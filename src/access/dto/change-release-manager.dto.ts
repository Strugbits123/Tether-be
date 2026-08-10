import {
  Equals,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { RmRelationshipType } from '../../release-managers/dto/create-release-manager.dto.js';

export class ChangeReleaseManagerDto {
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
  @IsEnum(RmRelationshipType)
  relationship: RmRelationshipType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @Equals(true, { message: 'legal_acknowledged must be true' })
  legal_acknowledged: boolean;
}
