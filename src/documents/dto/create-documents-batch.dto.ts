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
  @MaxLength(500)
  storagePath: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  originalFilename: string;

  // Must stay a superset of the values MIME_TO_EXT (documents.service.ts) can
  // produce. A MIME accepted at the signed-URL step but rejected here fails
  // *after* the bytes are already in storage, orphaning the object — which is
  // exactly what happened while 'm4v' (from video/x-m4v) was missing.
  @IsIn([
    'pdf', 'docx', 'doc', 'jpg', 'jpeg', 'png', 'heic',
    'mp3', 'm4a', 'wav', 'ogg', 'aac', 'webm', 'mp4', 'mov', 'm4v', 'avi', 'mpeg',
  ])
  fileType: string;

  @IsInt()
  @Min(1)
  @Max(52428800)
  fileSizeBytes: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
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
  @MaxLength(100)
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
