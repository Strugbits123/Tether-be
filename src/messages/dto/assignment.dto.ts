import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export class AssignmentDto {
  @IsIn(['all', 'group', 'release_manager', 'assign_later', 'individual'])
  scope: string;

  @IsOptional()
  @IsIn(['family', 'friends', 'others'])
  groupValue?: string | null;

  @IsOptional()
  @IsUUID()
  recipientId?: string | null;
}
