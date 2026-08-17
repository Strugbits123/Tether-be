import {
  Body,
  Controller,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CreateRecipientDto } from './dto/create-recipient.dto.js';
import { RecipientsService } from './recipients.service.js';

@Controller('recipients')
@UseGuards(JwtAuthGuard)
export class RecipientsController {
  constructor(private readonly recipientsService: RecipientsService) {}

  // POST /api/v1/recipients
  @Post()
  async create(@Request() req: any, @Body() dto: CreateRecipientDto) {
    return this.recipientsService.create(req.user.id, dto);
  }

  // GET /api/v1/recipients
  @Get()
  async findAll(@Request() req: any) {
    return this.recipientsService.findAll(req.user.id);
  }
}
