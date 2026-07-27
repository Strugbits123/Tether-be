import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RecipientsModule } from '../recipients/recipients.module.js';
import { ReleaseManagersModule } from '../release-managers/release-managers.module.js';
import { GuardiansModule } from '../guardians/guardians.module.js';
import { AccessController } from './access.controller.js';
import { AccessService } from './access.service.js';

@Module({
  imports: [AuthModule, RecipientsModule, ReleaseManagersModule, GuardiansModule],
  controllers: [AccessController],
  providers: [AccessService],
})
export class AccessModule {}
