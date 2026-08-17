import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { FeedbackService } from './feedback.service.js';
import { ScreenshotUploadUrlDto } from './dto/screenshot-upload-url.dto.js';
import { SubmitFeedbackDto } from './dto/submit-feedback.dto.js';

@Controller('feedback')
@UseGuards(JwtAuthGuard)
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post('screenshot-upload-url')
  getScreenshotUploadUrl(
    @Request() req: any,
    @Body() dto: ScreenshotUploadUrlDto,
  ) {
    return this.feedbackService.getScreenshotUploadUrl(req.user.id, dto);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  submitFeedback(@Request() req: any, @Body() dto: SubmitFeedbackDto) {
    return this.feedbackService.submitFeedback(req.user.id, dto);
  }
}
