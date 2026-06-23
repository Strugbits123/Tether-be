import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AssignmentDto } from './assignment.dto.js';

export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsOptional()
  @IsIn([
    'financial',
    'legal',
    'insurance',
    'medical',
    'property',
    'digital_accounts',
    'personal',
    'military',
    'other',
  ])
  category?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssignmentDto)
  assignments?: AssignmentDto[];
}
