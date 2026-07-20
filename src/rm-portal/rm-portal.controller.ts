import { Body, Controller, Get, Param, Patch, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AccountContextGuard } from '../auth/guards/account-context.guard.js';
import { RoleGuard, Roles } from '../auth/guards/role.guard.js';
import { RetryEmailDto } from './dto/retry-email.dto.js';
import { RmPortalService } from './rm-portal.service.js';

@Controller('rm')
@UseGuards(JwtAuthGuard, AccountContextGuard, RoleGuard)
@Roles('release_manager', 'guardian')
export class RmPortalController {
  constructor(private readonly rmPortalService: RmPortalService) {}

  @Get('overview')
  async getOverview(@Request() req: any) {
    return this.rmPortalService.getOverview(req.accountContext.accountOwnerId);
  }

  @Get('recipients')
  async listRecipients(@Request() req: any) {
    return this.rmPortalService.listRecipients(req.accountContext.accountOwnerId);
  }

  @Get('recipients/:id')
  async getRecipient(@Request() req: any, @Param('id') id: string) {
    return this.rmPortalService.getRecipient(req.accountContext.accountOwnerId, id);
  }

  @Patch('recipients/:id/retry-email')
  async retryEmail(@Request() req: any, @Param('id') id: string, @Body() dto: RetryEmailDto) {
    return this.rmPortalService.retryRecipientEmail(req.accountContext.accountOwnerId, id, dto);
  }
}
