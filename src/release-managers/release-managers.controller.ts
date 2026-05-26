import {
  Body,
  Controller,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ReleaseManagersService } from './release-managers.service.js';
import { CreateReleaseManagerDto } from './dto/create-release-manager.dto.js';

@Controller('release-managers')
@UseGuards(JwtAuthGuard)
export class ReleaseManagersController {
  constructor(
    private readonly releaseManagersService: ReleaseManagersService,
  ) {}

  @Post()
  designate(@Request() req: any, @Body() dto: CreateReleaseManagerDto) {
    return this.releaseManagersService.designate(req.user.id, dto);
  }

  @Get('active')
  getActive(@Request() req: any) {
    return this.releaseManagersService.getActive(req.user.id);
  }
}
