import {
  Body,
  Controller,
  Delete,
  Headers,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AccountContextGuard } from '../auth/guards/account-context.guard.js';
import { RoleGuard, Roles } from '../auth/guards/role.guard.js';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { InviteReleaseManagerDto } from './dto/invite-release-manager.dto.js';
import { InviteGuardianDto } from './dto/invite-guardian.dto.js';
import { InviteRecipientDto } from './dto/invite-recipient.dto.js';
import { InvitationsService } from './invitations.service.js';

@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly invitationsService: InvitationsService,
    private readonly supabase: SupabaseService,
  ) {}

  @Post('release-manager')
  @UseGuards(JwtAuthGuard, AccountContextGuard, RoleGuard)
  @Roles('owner')
  async inviteReleaseManager(
    @Request() req: any,
    @Body() dto: InviteReleaseManagerDto,
  ) {
    return this.invitationsService.inviteReleaseManager(
      req.accountContext.accountOwnerId,
      dto,
    );
  }

  @Post('guardian')
  @UseGuards(JwtAuthGuard, AccountContextGuard, RoleGuard)
  @Roles('owner')
  async inviteGuardian(@Request() req: any, @Body() dto: InviteGuardianDto) {
    return this.invitationsService.inviteGuardian(
      req.accountContext.accountOwnerId,
      dto,
    );
  }

  @Post('recipient')
  @UseGuards(JwtAuthGuard, AccountContextGuard, RoleGuard)
  @Roles('owner')
  async inviteRecipient(@Request() req: any, @Body() dto: InviteRecipientDto) {
    return this.invitationsService.inviteRecipient(
      req.accountContext.accountOwnerId,
      dto,
    );
  }

  // Reachable by both logged-in and anonymous visitors — resolves the caller
  // manually via the bearer token instead of JwtAuthGuard, which would 401 an
  // unauthenticated click-through from the invitation email.
  //
  // POST, not GET: accepting an invitation mutates state (it creates the
  // membership), so it must not sit behind a safe/idempotent method that link
  // previewers, crawlers and browser prefetch are free to fetch on their own.
  // The frontend only calls this from an explicit button submission.
  @Post('accept/:token')
  async acceptInvitation(
    @Param('token') token: string,
    @Headers('authorization') authHeader?: string,
  ) {
    const userId = await this.resolveOptionalUserId(authHeader);
    return this.invitationsService.acceptInvitation(token, userId);
  }

  @Post('resend/:id')
  @UseGuards(JwtAuthGuard, AccountContextGuard, RoleGuard)
  @Roles('owner')
  async resendInvitation(@Request() req: any, @Param('id') id: string) {
    return this.invitationsService.resendInvitation(
      req.accountContext.accountOwnerId,
      id,
    );
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, AccountContextGuard, RoleGuard)
  @Roles('owner')
  async revokeInvitation(@Request() req: any, @Param('id') id: string) {
    return this.invitationsService.revokeInvitation(
      req.accountContext.accountOwnerId,
      id,
    );
  }

  private async resolveOptionalUserId(
    authHeader?: string,
  ): Promise<string | null> {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const { data, error } = await this.supabase.getClient().auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  }
}
