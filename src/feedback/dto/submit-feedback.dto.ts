import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class SubmitFeedbackDto {
  @IsIn(['bug_report', 'feature_request', 'general_feedback'])
  type: string;

  @ValidateIf((o) => o.type === 'bug_report')
  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string;

  @ValidateIf((o) => o.type === 'bug_report' || o.type === 'general_feedback')
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  description?: string;

  @ValidateIf((o) => o.type === 'feature_request')
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  feature_description?: string;

  @ValidateIf((o) => o.type === 'feature_request')
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  feature_benefit?: string;

  @ValidateIf((o) => o.type === 'general_feedback')
  @IsOptional()
  @IsString()
  @IsIn(['praise', 'suggestion', 'complaint', 'question', 'other'])
  feedback_type?: string;

  @ValidateIf((o) => o.type === 'bug_report' || o.type === 'general_feedback')
  @IsOptional()
  @IsString()
  @MaxLength(500)
  screenshot_path?: string;
}
