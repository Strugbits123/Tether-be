import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class PhotoItemDto {
  @IsString()
  @IsNotEmpty()
  storagePath: string;

  @IsIn(['jpeg', 'jpg', 'png', 'heic', 'webp'])
  fileType: string;

  @IsInt()
  @Min(1)
  @Max(10485760)
  fileSizeBytes: number;

  @IsOptional()
  @IsInt()
  width?: number | null;

  @IsOptional()
  @IsInt()
  height?: number | null;
}

export class AssignmentDto {
  @IsIn(['all', 'group', 'release_manager', 'assign_later', 'individual'])
  scope: string;

  @IsOptional()
  @IsString()
  groupValue?: string | null;

  @IsOptional()
  @IsUUID()
  recipientId?: string | null;
}

export class CreatePhotosBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PhotoItemDto)
  photos: PhotoItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  caption?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssignmentDto)
  assignments: AssignmentDto[];
}
