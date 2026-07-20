import { Controller, Get, Param } from '@nestjs/common';
import { ReleasePlanService } from './release-plan.service.js';

// Public — no auth. Lets an account owner cancel a release even if they
// can't log in (e.g. incapacitated), via the link mailed to them at
// initiation time. Protected by the unguessable cancel_token, not a session.
@Controller('release')
export class ReleaseCancelController {
  constructor(private readonly releasePlanService: ReleasePlanService) {}

  @Get('cancel/:token')
  async cancel(@Param('token') token: string) {
    return this.releasePlanService.cancelByToken(token);
  }
}
