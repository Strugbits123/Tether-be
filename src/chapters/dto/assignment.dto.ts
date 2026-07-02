import { IsIn, IsOptional, IsUUID } from 'class-validator';
import {
  ASSIGNMENT_SCOPES,
  GROUP_VALUES,
} from '../../common/constants/assignments.js';

export class ChapterAssignmentDto {
  @IsIn([...ASSIGNMENT_SCOPES])
  assignment_scope: string;

  @IsOptional()
  @IsIn([...GROUP_VALUES])
  group_value?: string | null;

  @IsOptional()
  @IsUUID()
  recipient_id?: string | null;
}
