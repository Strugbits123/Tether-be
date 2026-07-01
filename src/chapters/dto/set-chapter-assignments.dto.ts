import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';
import { ChapterAssignmentDto } from './assignment.dto.js';

export class SetChapterAssignmentsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChapterAssignmentDto)
  assignments: ChapterAssignmentDto[];
}
