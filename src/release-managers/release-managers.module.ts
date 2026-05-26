import { Module } from '@nestjs/common';
import { ReleaseManagersController } from './release-managers.controller.js';
import { ReleaseManagersService } from './release-managers.service.js';

@Module({
  controllers: [ReleaseManagersController],
  providers: [ReleaseManagersService],
  exports: [ReleaseManagersService],
})
export class ReleaseManagersModule {}
