import { IsIn, IsUUID } from 'class-validator';

export class ContentItemDto {
  @IsIn(['message', 'document', 'photo', 'chapter'])
  contentType: string;

  @IsUUID()
  contentId: string;
}
