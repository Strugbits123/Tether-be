import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ReleasePlanService } from './release-plan.service.js';

// Public — no auth. Lets an account owner cancel a release even if they
// can't log in (e.g. incapacitated), via the link mailed to them at
// initiation time. Protected by the unguessable cancel_token, not a session.
//
// GET only renders a confirmation page (read-only lookup) — the actual
// cancellation is a separate POST, so a link preview/crawler or prefetch
// hitting the GET can never cancel a release as a side effect.
@Controller('release')
export class ReleaseCancelController {
  constructor(private readonly releasePlanService: ReleasePlanService) {}

  @Get('cancel/:token')
  async peek(@Param('token') token: string) {
    return this.releasePlanService.peekCancelStatus(token);
  }

  @Post('cancel/:token')
  @HttpCode(200)
  async confirm(@Param('token') token: string) {
    return this.releasePlanService.cancelByToken(token);
  }
}
