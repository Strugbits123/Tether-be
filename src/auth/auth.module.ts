import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthWebhookController } from './auth-webhook.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';

@Module({
  controllers: [AuthController, AuthWebhookController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
