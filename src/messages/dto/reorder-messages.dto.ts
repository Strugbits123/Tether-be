import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReorderItemDto {
  @IsUUID()
  messageId: string;

  @IsInt()
  @Min(0)
  displayOrder: number;
}

export class ReorderMessagesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  order: ReorderItemDto[];
}
