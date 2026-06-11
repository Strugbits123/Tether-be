import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { UsersService } from './users.service.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { AvatarUploadDto } from './dto/avatar-upload.dto.js';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getMe(@Request() req: any) {
    return this.usersService.getMe(req.user.id);
  }

  @Patch('profile')
  async updateProfile(@Request() req: any, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(req.user.id, dto);
  }

  @Post('avatar-upload-url')
  getAvatarUploadUrl(@Request() req: any, @Body() dto: AvatarUploadDto) {
    return this.usersService.getAvatarUploadUrl(req.user.id, dto.fileType);
  }

  @Post('onboarding/complete')
  @UseGuards(JwtAuthGuard)
  completeOnboarding(@Request() req: any) {
    return this.usersService.completeOnboarding(req.user.id);
  }

  @Post('onboarding/purposes')
  saveOnboardingPurposes(
    @Request() req: any,
    @Body('purposes') purposes: string[],
  ) {
    return this.usersService.saveOnboardingPurposes(req.user.id, purposes);
  }

  @Get('onboarding/state')
  @UseGuards(JwtAuthGuard)
  getOnboarding(@Request() req: any, @Body('purposes') purposes: string[]) {
    return this.usersService.saveOnboardingPurposes(req.user.id, purposes);
  }
}
