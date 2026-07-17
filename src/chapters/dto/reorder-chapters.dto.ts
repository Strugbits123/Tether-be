import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class ChapterOrderItemDto {
  @IsUUID()
  id: string;

  @IsInt()
  @Min(0)
  display_order: number;
}

export class ReorderChaptersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ChapterOrderItemDto)
  order: ChapterOrderItemDto[];
}
