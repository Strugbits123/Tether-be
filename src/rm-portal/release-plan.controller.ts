import { timingSafeEqual } from 'crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Patch,
  Post,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AccountContextGuard } from '../auth/guards/account-context.guard.js';
import { RoleGuard, Roles } from '../auth/guards/role.guard.js';
import { InitiateReleaseDto } from './dto/initiate-release.dto.js';
import { CancelReleaseDto } from './dto/cancel-release.dto.js';
import { GuardianRequestDto } from './dto/guardian-request.dto.js';
import { OverrideScheduleDto } from './dto/override-schedule.dto.js';
import { ReleasePlanService } from './release-plan.service.js';

@Controller('rm/release-plan')
@UseGuards(JwtAuthGuard, AccountContextGuard, RoleGuard)
@Roles('release_manager', 'guardian')
export class ReleasePlanController {
  constructor(
    private readonly releasePlanService: ReleasePlanService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Gate for the delivery-date override.
   *
   * The secret is verified here rather than in the frontend on purpose. Anything
   * a Next.js client can read is compiled into the JS bundle (NEXT_PUBLIC_*) and
   * visible in devtools, and a client-side check is bypassed by calling this
   * endpoint directly — which would leave the date that releases someone's entire
   * legacy effectively unauthenticated. The operator types the password, the
   * server compares it.
   *
   * Absent config disables the route entirely and answers 404, so production can
   * simply not set the variable and the endpoint ceases to exist as far as any
   * caller can tell.
   */
  private assertOverrideAuthorised(provided: string | undefined): void {
    const expected = this.config.get<string>(
      'RELEASE_SCHEDULE_OVERRIDE_SECRET',
    );

    if (!expected) {
      throw new NotFoundException();
    }

    if (!provided) {
      throw new ForbiddenException('Override password required.');
    }

    // Length-prefixed compare: timingSafeEqual throws on a length mismatch, and
    // comparing with === would leak the secret's length through timing.
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('Incorrect override password.');
    }
  }

  /**
   * QA/support only: move an active plan's delivery date so the post-waiting-period
   * steps can be tested without waiting five business days.
   *
   * Requires all four of: a valid session, an account context, the
   * release_manager role, and the override secret. Every call is written to the
   * release activity log.
   */
  @Patch('schedule')
  @Roles('release_manager')
  async overrideSchedule(
    @Request() req: any,
    @Headers('x-release-override-secret') secret: string | undefined,
    @Body() dto: OverrideScheduleDto,
  ) {
    this.assertOverrideAuthorised(secret);
    return this.releasePlanService.overrideDeliverySchedule(
      req.accountContext.accountOwnerId,
      dto.deliveryScheduledAt,
    );
  }

  @Get()
  async getReleasePlan(@Request() req: any) {
    return this.releasePlanService.getReleasePlan(req.accountContext.accountOwnerId);
  }

  // Narrower than the class default: initiateRelease hardcodes
  // initiator_role: 'release_manager' and resolves initiator_rm_id from
  // release_managers by rm_user_id, so a guardian-initiated release would be
  // recorded with the wrong role and a null RM id, corrupting the audit trail
  // the activity report and cancel flows read back.
  @Post('initiate')
  @Roles('release_manager')
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
      'Content-Length': buffer.length,
    });
    // res.attachment() rather than interpolating into the header ourselves:
    // filename derives from plan.plan_id, and a quote or CR/LF in that value
    // would otherwise break out of the quoted header value.
    res.attachment(filename);
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
