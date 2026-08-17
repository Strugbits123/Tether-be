import {
  Body,
  Controller,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CreateReleaseManagerDto } from './dto/create-release-manager.dto.js';
import { ReleaseManagersService } from './release-managers.service.js';

@Controller('release-managers')
@UseGuards(JwtAuthGuard)
export class ReleaseManagersController {
  constructor(private readonly rmService: ReleaseManagersService) {}

  // POST /api/v1/release-managers
  @Post()
  async create(@Request() req: any, @Body() dto: CreateReleaseManagerDto) {
    return this.rmService.create(req.user.id, dto);
  }

  // GET /api/v1/release-managers
  @Get()
  async getActive(@Request() req: any) {
    return this.rmService.getActive(req.user.id);
  }
}
