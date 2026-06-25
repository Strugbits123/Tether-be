import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ContentService } from './content.service.js';
import { BulkAssignDto } from './dto/bulk-assign.dto.js';
import { BulkDeleteDto } from './dto/bulk-delete.dto.js';

@Controller('content')
@UseGuards(JwtAuthGuard)
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Get('unassigned')
  getUnassigned(@Request() req: any, @Query('type') type?: string) {
    return this.contentService.getUnassigned(req.user.id, type);
  }

  @Post('bulk-assign')
  bulkAssign(@Request() req: any, @Body() dto: BulkAssignDto) {
    return this.contentService.bulkAssign(req.user.id, dto);
  }

  @Post('bulk-delete')
  bulkDelete(@Request() req: any, @Body() dto: BulkDeleteDto) {
    return this.contentService.bulkDelete(req.user.id, dto);
  }
}
