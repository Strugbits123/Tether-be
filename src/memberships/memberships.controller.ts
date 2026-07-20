import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AccountContextGuard } from '../auth/guards/account-context.guard.js';
import { SwitchContextDto } from './dto/switch-context.dto.js';
import { MembershipsService } from './memberships.service.js';

@Controller('auth')
@UseGuards(JwtAuthGuard)
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}

  // GET /api/v1/auth/memberships
  @Get('memberships')
  async listMemberships(@Request() req: any) {
    return this.membershipsService.listMemberships(req.user.id);
  }

  // POST /api/v1/auth/switch-context
  @Post('switch-context')
  async switchContext(@Request() req: any, @Body() dto: SwitchContextDto) {
    return this.membershipsService.switchContext(
      req.user.id,
      dto.membershipId,
    );
  }

  // GET /api/v1/auth/active-context
  @Get('active-context')
  @UseGuards(AccountContextGuard)
  async getActiveContext(@Request() req: any) {
    return this.membershipsService.getActiveContext(
      req.user.id,
      req.accountContext.membershipId,
    );
  }
}
