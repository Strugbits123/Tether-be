import { IsOptional, IsUUID } from 'class-validator';

export class MovePhotoDto {
  @IsOptional()
  @IsUUID()
  folderId?: string | null;
}
