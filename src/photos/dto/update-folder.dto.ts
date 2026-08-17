import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AssignmentDto } from './create-photos-batch.dto.js';

export class UpdateFolderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  // Optional: when provided, the folder's recipient assignments are replaced
  // with this list. Omitted → assignments are left untouched (rename-only).
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssignmentDto)
  assignments?: AssignmentDto[];
}
