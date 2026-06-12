import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class FileDescriptorDto {
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsIn(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
  fileType: string;

  @IsInt()
  @Min(1)
  @Max(10485760)
  fileSizeBytes: number;
}

export class RequestUploadUrlsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => FileDescriptorDto)
  files: FileDescriptorDto[];
}
