import { Controller, Get, Param, Patch, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AccountContextGuard } from '../auth/guards/account-context.guard.js';
import { RoleGuard, Roles } from '../auth/guards/role.guard.js';
import { RmNotificationsService } from './rm-notifications.service.js';

@Controller('rm/notifications')
@UseGuards(JwtAuthGuard, AccountContextGuard, RoleGuard)
@Roles('release_manager', 'guardian')
export class RmNotificationsController {
  constructor(private readonly rmNotificationsService: RmNotificationsService) {}

  @Get()
  async list(@Request() req: any) {
    return this.rmNotificationsService.listNotifications(req.accountContext.userId);
  }

  @Patch(':id/read')
  async markRead(@Request() req: any, @Param('id') id: string) {
    return this.rmNotificationsService.markRead(req.accountContext.userId, id);
  }

  @Patch(':id/unread')
  async markUnread(@Request() req: any, @Param('id') id: string) {
    return this.rmNotificationsService.markUnread(req.accountContext.userId, id);
  }

  @Get('unread-count')
  async unreadCount(@Request() req: any) {
    return this.rmNotificationsService.unreadCount(req.accountContext.userId);
  }
}
