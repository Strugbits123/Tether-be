import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class ChapterAssignmentDto {
  @IsIn(['all', 'group', 'release_manager', 'assign_later', 'individual'])
  assignment_scope: string;

  @IsOptional()
  @IsIn(['family', 'friends', 'others'])
  group_value?: string | null;

  @IsOptional()
  @IsUUID()
  recipient_id?: string | null;
}
