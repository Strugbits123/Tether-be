import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RecipientsService } from './recipients.service.js';
import { CreateRecipientDto } from './dto/create-recipient.dto.js';

@Controller('recipients')
@UseGuards(JwtAuthGuard)
export class RecipientsController {
  constructor(private readonly recipientsService: RecipientsService) {}

  @Post()
  create(@Request() req: any, @Body() dto: CreateRecipientDto) {
    return this.recipientsService.create(req.user.id, dto);
  }

  @Get()
  findAll(@Request() req: any) {
    return this.recipientsService.findAll(req.user.id);
  }

  @Delete(':id')
  remove(@Request() req: any, @Param('id') id: string) {
    return this.recipientsService.remove(req.user.id, id);
  }
}
