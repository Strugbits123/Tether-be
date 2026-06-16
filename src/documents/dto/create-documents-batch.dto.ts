import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AssignmentDto } from './assignment.dto.js';

export class DocumentItemDto {
  @IsString()
  @IsNotEmpty()
  storagePath: string;

  @IsString()
  @IsNotEmpty()
  originalFilename: string;

  @IsIn(['pdf', 'docx', 'jpg', 'jpeg', 'png', 'heic'])
  fileType: string;

  @IsInt()
  @Min(1)
  @Max(26214400)
  fileSizeBytes: number;

  @IsOptional()
  @IsString()
  title?: string;

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
  @IsString()
  mimeType?: string;
}

export class CreateDocumentsBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => DocumentItemDto)
  documents: DocumentItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssignmentDto)
  assignments: AssignmentDto[];
}
