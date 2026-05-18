import {
  Body,
  Controller,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { SignupDto } from './dto/signup.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { MagicLinkDto } from './dto/magic-link.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { UpdatePasswordDto } from './dto/update-password.dto.js';

@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Public routes — no JWT required

  @Post('signup')
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 attempts per minute
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 attempts per minute
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('magic-link')
  @Throttle({ default: { limit: 3, ttl: 60000 } }) // 3 per minute
  magicLink(@Body() dto: MagicLinkDto) {
    return this.authService.magicLink(dto);
  }

  @Post('reset-password')
  @Throttle({ default: { limit: 3, ttl: 60000 } }) // 3 per minute
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('refresh')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  refresh(@Body('refresh_token') refreshToken: string) {
    return this.authService.refreshToken(refreshToken);
  }

  @Get('google')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  googleAuth() {
    return this.authService.getGoogleOAuthUrl();
  }

  // Protected routes — JWT required

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  logout(@Request() req: any) {
    return this.authService.logout(req.accessToken);
  }

  @Post('update-password')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  updatePassword(@Request() req: any, @Body() dto: UpdatePasswordDto) {
    return this.authService.updatePassword(req.user.id, dto);
  }
}
