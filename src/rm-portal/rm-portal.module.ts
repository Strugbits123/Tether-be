import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { GuardiansModule } from '../guardians/guardians.module.js';
import { MemoirModule } from '../memoir/memoir.module.js';
import { RmPortalController } from './rm-portal.controller.js';
import { RmPortalService } from './rm-portal.service.js';
import { ReleasePlanController } from './release-plan.controller.js';
import { ReleasePlanService } from './release-plan.service.js';
import { ReleaseCancelController } from './release-cancel.controller.js';
import { RmNotificationsController } from './rm-notifications.controller.js';
import { RmNotificationsService } from './rm-notifications.service.js';
import { RmDownloadsController } from './rm-downloads.controller.js';
import { RmDownloadsService } from './rm-downloads.service.js';

@Module({
  imports: [AuthModule, GuardiansModule, MemoirModule],
  controllers: [
    RmPortalController,
    ReleasePlanController,
    ReleaseCancelController,
    RmNotificationsController,
    RmDownloadsController,
  ],
  providers: [RmPortalService, ReleasePlanService, RmNotificationsService, RmDownloadsService],
  exports: [ReleasePlanService],
})
export class RmPortalModule {}
