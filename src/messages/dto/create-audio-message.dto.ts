import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { AssignmentDto } from './assignment.dto.js';

export class CreateAudioMessageDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssignmentDto)
  assignments: AssignmentDto[];

  @IsIn(['audio/webm', 'audio/mp4', 'audio/wav', 'audio/mpeg', 'audio/ogg'])
  fileType: string;
}
