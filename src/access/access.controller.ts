import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AddRecipientDto } from './dto/add-recipient.dto.js';
import { UpdateRecipientDto } from './dto/update-recipient.dto.js';
import { ChangeReleaseManagerDto } from './dto/change-release-manager.dto.js';
import { DesignateGuardianDto } from './dto/designate-guardian.dto.js';
import { AccessService } from './access.service.js';

@Controller('access')
@UseGuards(JwtAuthGuard)
export class AccessController {
  constructor(private readonly accessService: AccessService) {}

  @Get('overview')
  async getOverview(@Request() req: any) {
    return this.accessService.getOverview(req.user.id);
  }

  @Post('recipients')
  async addRecipient(@Request() req: any, @Body() dto: AddRecipientDto) {
    return this.accessService.addRecipient(req.user.id, dto);
  }

  @Patch('recipients/:id')
  async updateRecipient(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateRecipientDto,
  ) {
    return this.accessService.updateRecipient(req.user.id, id, dto);
  }

  @Delete('recipients/:id')
  async removeRecipient(@Request() req: any, @Param('id') id: string) {
    return this.accessService.removeRecipient(req.user.id, id);
  }

  @Post('recipients/:id/guardian')
  async designateGuardian(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: DesignateGuardianDto,
  ) {
    return this.accessService.designateGuardian(req.user.id, id, dto);
  }

  @Delete('recipients/:id/guardian')
  async removeGuardian(@Request() req: any, @Param('id') id: string) {
    return this.accessService.removeGuardianDesignation(req.user.id, id);
  }

  @Post('release-manager')
  async setReleaseManager(@Request() req: any, @Body() dto: ChangeReleaseManagerDto) {
    return this.accessService.setReleaseManager(req.user.id, dto);
  }

  @Post('release-manager/remind')
  async remindReleaseManager(@Request() req: any) {
    return this.accessService.remindReleaseManager(req.user.id);
  }

  @Get('recipients/:id/content')
  async getRecipientContent(@Request() req: any, @Param('id') id: string) {
    return this.accessService.getRecipientContent(req.user.id, id);
  }
}
