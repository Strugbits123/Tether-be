import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RecipientsModule } from '../recipients/recipients.module.js';
import { ReleaseManagersModule } from '../release-managers/release-managers.module.js';
import { GuardiansModule } from '../guardians/guardians.module.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

@Module({
  imports: [AuthModule, RecipientsModule, ReleaseManagersModule, GuardiansModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
