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

  // Video messages live in Mux and can't go in the ZIP — listed separately so
  // they can be downloaded one at a time.
  @Get('videos')
  async getVideos(@Request() req: any) {
    return this.rmDownloadsService.listVideos(req.accountContext.accountOwnerId);
  }

  @Post('prepare')
  async prepare(@Request() req: any, @Body() dto: PrepareDownloadDto, @Res() res: Response) {
    const { archive, filename, populate } =
      await this.rmDownloadsService.prepareDownload(
        req.accountContext.accountOwnerId,
        dto,
      );

    res.set({ 'Content-Type': 'application/zip' });
    res.attachment(filename);

    let streamFailed = false;
    archive.on('error', (err: Error) => {
      streamFailed = true;
      this.logger.error('Archive stream failed while preparing download', err);
      if (!res.headersSent) {
        res.status(500);
        res.end();
        return;
      }
      // Same trap as the catch below: res.end() mid-archive completes the
      // response and yields a ZIP with no central directory that the client
      // stores as a finished download. Destroy the socket so it registers as a
      // failed transfer instead.
      res.destroy(err);
    });

    // Pipe before populating so entries stream to the client as they're
    // compressed, instead of accumulating in memory with nothing draining them.
    archive.pipe(res);

    // Both of these can reject after the response is already streaming, where
    // there's no way to change the status code — log and close rather than let
    // the rejection escape this handler as an unhandled promise rejection.
    try {
      await populate();
      await archive.finalize();
    } catch (err) {
      if (!streamFailed) {
        this.logger.error('Failed to build download archive', err);
      }
      if (!res.headersSent) {
        res.status(500);
        res.end();
        return;
      }

      // Headers are already out and entries have already been written, so the
      // status code can't be changed. Critically, do NOT res.end() here: that
      // completes the HTTP response and hands over a ZIP with entries but no
      // central directory, which the client saves happily and every extractor
      // then rejects as invalid. Abort the archive and destroy the socket so the
      // transfer is seen as failed and no file is kept.
      archive.abort();
      res.destroy(err instanceof Error ? err : new Error('Archive build failed'));
    }
  }
}
