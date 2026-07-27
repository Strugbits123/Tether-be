import {
  Body,
  Controller,
  Get,
  Post,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AccountContextGuard } from '../auth/guards/account-context.guard.js';
import { RoleGuard, Roles } from '../auth/guards/role.guard.js';
import { InitiateReleaseDto } from './dto/initiate-release.dto.js';
import { CancelReleaseDto } from './dto/cancel-release.dto.js';
import { GuardianRequestDto } from './dto/guardian-request.dto.js';
import { ReleasePlanService } from './release-plan.service.js';

@Controller('rm/release-plan')
@UseGuards(JwtAuthGuard, AccountContextGuard, RoleGuard)
@Roles('release_manager', 'guardian')
export class ReleasePlanController {
  constructor(private readonly releasePlanService: ReleasePlanService) {}

  @Get()
  async getReleasePlan(@Request() req: any) {
    return this.releasePlanService.getReleasePlan(req.accountContext.accountOwnerId);
  }

  @Post('initiate')
  async initiate(@Request() req: any, @Body() dto: InitiateReleaseDto) {
    return this.releasePlanService.initiateRelease(
      req.accountContext.accountOwnerId,
      req.accountContext.userId,
      dto,
    );
  }

  @Post('cancel')
  async cancel(@Request() req: any, @Body() dto: CancelReleaseDto) {
    return this.releasePlanService.cancelRelease(req.accountContext.accountOwnerId, dto);
  }

  @Get('notification-status')
  async notificationStatus(@Request() req: any) {
    return this.releasePlanService.getNotificationStatus(req.accountContext.accountOwnerId);
  }

  @Post('continue-delivery')
  async continueDelivery(@Request() req: any) {
    return this.releasePlanService.continueDelivery(req.accountContext.accountOwnerId);
  }

  @Get('delivery-status')
  async deliveryStatus(@Request() req: any) {
    return this.releasePlanService.getDeliveryStatus(req.accountContext.accountOwnerId);
  }

  @Get('activity-log')
  async activityLog(@Request() req: any) {
    return this.releasePlanService.getActivityLog(req.accountContext.accountOwnerId);
  }

  @Get('activity-report')
  async activityReport(@Request() req: any, @Res() res: Response) {
    const { buffer, filename } = await this.releasePlanService.generateActivityReportPdf(
      req.accountContext.accountOwnerId,
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }

  @Post('guardian-request')
  async guardianRequest(@Request() req: any, @Body() dto: GuardianRequestDto) {
    return this.releasePlanService.requestGuardianEscalation(
      req.accountContext.accountOwnerId,
      req.accountContext.userId,
      dto,
    );
  }
}
