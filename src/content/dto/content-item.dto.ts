import { IsIn, IsUUID } from 'class-validator';

export class ContentItemDto {
  @IsIn(['message', 'document', 'photo', 'memoir'])
  contentType: string;

  @IsUUID()
  contentId: string;
}
