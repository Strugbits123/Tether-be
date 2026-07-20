import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthWebhookController } from './auth-webhook.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { AccountContextGuard } from './guards/account-context.guard.js';
import { RoleGuard } from './guards/role.guard.js';

@Module({
  controllers: [AuthController, AuthWebhookController],
  providers: [AuthService, JwtAuthGuard, AccountContextGuard, RoleGuard],
  exports: [AuthService, JwtAuthGuard, AccountContextGuard, RoleGuard],
})
export class AuthModule {}
