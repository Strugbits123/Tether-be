import { Body, Controller, Get, Logger, Post, Request, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AccountContextGuard } from '../auth/guards/account-context.guard.js';
import { RoleGuard, Roles } from '../auth/guards/role.guard.js';
import { PrepareDownloadDto } from './dto/prepare-download.dto.js';
import { RmDownloadsService } from './rm-downloads.service.js';

@Controller('rm/downloads')
@UseGuards(JwtAuthGuard, AccountContextGuard, RoleGuard)
@Roles('release_manager', 'guardian')
export class RmDownloadsController {
  private readonly logger = new Logger(RmDownloadsController.name);

  constructor(private readonly rmDownloadsService: RmDownloadsService) {}

  @Get('summary')
  async getSummary(@Request() req: any) {
    return this.rmDownloadsService.getSummary(req.accountContext.accountOwnerId);
  }

  @Post('prepare')
  async prepare(@Request() req: any, @Body() dto: PrepareDownloadDto, @Res() res: Response) {
    const { archive, filename } = await this.rmDownloadsService.prepareDownload(
      req.accountContext.accountOwnerId,
      dto,
    );

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });

    archive.on('error', (err: Error) => {
      this.logger.error('Archive stream failed while preparing download', err);
      if (!res.headersSent) {
        res.status(500);
      }
      res.end();
    });

    archive.pipe(res);
    await archive.finalize();
  }
}
