import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class AssignmentDto {
  @IsIn(['all', 'group', 'release_manager', 'assign_later', 'individual'])
  scope: string;

  // Group values mirror the recipient RelationshipType enum so a "group"
  // assignment can target recipients by relationship.
  @IsOptional()
  @IsIn(['family', 'friend', 'partner', 'colleague', 'other'])
  groupValue?: string | null;

  @IsOptional()
  @IsUUID()
  recipientId?: string | null;
}
