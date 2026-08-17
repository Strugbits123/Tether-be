import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { ChapterAssignmentDto } from './assignment.dto.js';

export class SetChapterAssignmentsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChapterAssignmentDto)
  assignments: ChapterAssignmentDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
