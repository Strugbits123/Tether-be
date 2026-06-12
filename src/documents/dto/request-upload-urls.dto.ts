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

export class DocumentFileDescriptorDto {
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsIn([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'image/heic',
  ])
  fileType: string;

  @IsInt()
  @Min(1)
  @Max(26214400)
  fileSizeBytes: number;
}

export class RequestUploadUrlsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => DocumentFileDescriptorDto)
  files: DocumentFileDescriptorDto[];
}
