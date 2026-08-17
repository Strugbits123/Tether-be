import { IsIn, IsOptional, IsUUID } from 'class-validator';
import {
  ASSIGNMENT_SCOPES,
  GROUP_VALUES,
} from '../../common/constants/assignments.js';

export class AssignmentDto {
  @IsIn([...ASSIGNMENT_SCOPES])
  scope: string;

  @IsOptional()
  @IsIn([...GROUP_VALUES])
  groupValue?: string | null;

  @IsOptional()
  @IsUUID()
  recipientId?: string | null;
}
