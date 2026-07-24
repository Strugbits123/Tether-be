import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { EmailService } from '../shared/email/email.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { RecipientsService } from '../recipients/recipients.service.js';
import { ReleaseManagersService } from '../release-managers/release-managers.service.js';
import { GuardiansService } from '../guardians/guardians.service.js';
import { NotificationLogService } from '../shared/notification-log/notification-log.service.js';
import { InviteReleaseManagerDto } from './dto/invite-release-manager.dto.js';
import { InviteGuardianDto } from './dto/invite-guardian.dto.js';
import { InviteRecipientDto } from './dto/invite-recipient.dto.js';
import { RelationshipType } from '../recipients/dto/create-recipient.dto.js';
import { RmRelationshipType } from '../release-managers/dto/create-release-manager.dto.js';

function splitName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  const idx = trimmed.indexOf(' ');
  if (idx === -1) return { firstName: trimmed, lastName: '' };
  return { firstName: trimmed.slice(0, idx), lastName: trimmed.slice(idx + 1) };
}

// The legacy recipients table only recognizes family/friend/other.
function toRecipientRelationship(rel: string): RelationshipType {
  if (rel === 'family') return RelationshipType.FAMILY;
  if (rel === 'friend') return RelationshipType.FRIEND;
  return RelationshipType.OTHER;
}

// The legacy release_managers table doesn't know about 'executor'.
function toRmRelationship(rel: string): RmRelationshipType {
  if (Object.values(RmRelationshipType).includes(rel as RmRelationshipType)) {
    return rel as RmRelationshipType;
  }
  return RmRelationshipType.OTHER;
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly emailService: EmailService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
    private readonly config: ConfigService,
    private readonly recipientsService: RecipientsService,
    private readonly releaseManagersService: ReleaseManagersService,
    private readonly guardiansService: GuardiansService,
    private readonly notificationLog: NotificationLogService,
  ) {}

  private get frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL') ?? 'https://app.jointether.com';
  }

  private async getOwner(ownerId: string) {
    const { data } = await this.supabase
      .getClient()
      .from('users')
      .select('id, full_name, email')
      .eq('id', ownerId)
      .single();
    return data;
  }

  // Checks whether `email` already belongs to a Tether user; returns the
  // matching user id (or null) so callers can decide between linking an
  // existing account vs. storing an invite_email.
  private async findExistingUserId(email: string): Promise<string | null> {
    const { data } = await this.supabase
      .getClient()
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .maybeSingle();
    return data?.id ?? null;
  }

  // POST /invitations/release-manager
  async inviteReleaseManager(ownerId: string, dto: InviteReleaseManagerDto) {
    const email = dto.email.toLowerCase();
    const owner = await this.getOwner(ownerId);
    if (!owner) throw new NotFoundException('Account owner not found');

    const { data: existingActiveRm } = await this.supabase
      .getClient()
      .from('account_memberships')
      .select('id')
      .eq('account_owner_id', ownerId)
      .eq('role', 'release_manager')
      .not('status', 'in', '("revoked","declined")')
      .maybeSingle();

    if (existingActiveRm) {
      throw new ConflictException(
        'An active Release Manager already exists for this account.',
      );
    }

    const userId = await this.findExistingUserId(email);

    const { data: membership, error } = await this.supabase
      .getClient()
      .from('account_memberships')
      .insert({
        user_id: userId,
        account_owner_id: ownerId,
        role: 'release_manager',
        status: 'pending',
        invite_email: email,
        invite_name: dto.name,
        relationship: dto.relationship,
        note: dto.note ?? null,
        invitation_sent_at: new Date().toISOString(),
      })
      .select('id, invite_email, invite_name, status, invitation_token, invitation_sent_at')
      .single();

    if (error || !membership) {
      throw new InternalServerErrorException(
        'Failed to designate Release Manager.',
      );
    }

    const { firstName, lastName } = splitName(dto.name);
    await this.releaseManagersService
      .create(ownerId, {
        firstName,
        lastName,
        email,
        phone: dto.phone,
        relationship: toRmRelationship(dto.relationship),
        note: dto.note,
      })
      .catch((err) => {
        this.logger.error('Failed to sync release_managers row', err);
      });

    const acceptUrl = `${this.frontendUrl}/invitations/accept/${membership.invitation_token}`;
    const messageId = await this.emailService
      .sendReleaseManagerInvitation({
        to: email,
        rmName: dto.name,
        ownerName: owner.full_name,
        ownerEmail: owner.email,
        acceptUrl,
      })
      .catch((err) => {
        this.logger.error('Failed to send RM invitation email', err);
        return null;
      });

    await this.notificationLog.logEmailSent({
      userId,
      recipientEmail: email,
      emailType: 'rm_invitation',
      resendMessageId: messageId,
      metadata: { account_owner_id: ownerId, role: 'release_manager', membership_id: membership.id },
    });

    this.activityService.log(
      ownerId,
      'release_manager_invited',
      `Release Manager invited — ${dto.name}`,
      { membershipId: membership.id, email, relationship: dto.relationship },
    );
    this.posthog.capture(ownerId, 'release_manager_invited', {
      relationship: dto.relationship,
    });

    return {
      id: membership.id,
      role: 'release_manager',
      invite_email: membership.invite_email,
      invite_name: membership.invite_name,
      status: membership.status,
      invitation_sent_at: membership.invitation_sent_at,
    };
  }

  // POST /invitations/guardian
  async inviteGuardian(ownerId: string, dto: InviteGuardianDto) {
    const email = dto.email.toLowerCase();
    const owner = await this.getOwner(ownerId);
    if (!owner) throw new NotFoundException('Account owner not found');

    // guardians.priority_order (1-3) is the DB's source of truth for the
    // max-guardian invariant — GuardiansService.create enforces it.
    const priorityOrder =
      dto.guardianOrder ?? (await this.guardiansService.nextPriorityOrder(ownerId));

    const userId = await this.findExistingUserId(email);

    const guardian = await this.guardiansService.create({
      accountId: ownerId,
      name: dto.name,
      email,
      relationship: dto.relationship,
      priorityOrder,
      userId,
    });

    const { data: membership, error } = await this.supabase
      .getClient()
      .from('account_memberships')
      .insert({
        user_id: userId,
        account_owner_id: ownerId,
        role: 'guardian',
        status: 'pending',
        invite_email: email,
        invite_name: dto.name,
        relationship: dto.relationship,
        invitation_sent_at: new Date().toISOString(),
      })
      .select('id, invite_email, invite_name, status, invitation_token, invitation_sent_at')
      .single();

    if (error || !membership) {
      // Roll back the guardians row so the two tables don't drift.
      await this.guardiansService.revoke(guardian.id).catch(() => null);
      throw new InternalServerErrorException('Failed to designate Guardian.');
    }

    const { data: activeRm } = await this.supabase
      .getClient()
      .from('release_managers')
      .select('name')
      .eq('user_id', ownerId)
      .not('status', 'in', '("revoked","declined")')
      .maybeSingle();

    const acceptUrl = `${this.frontendUrl}/invitations/accept/${membership.invitation_token}`;
    const messageId = await this.emailService
      .sendGuardianInvitation({
        to: email,
        guardianName: dto.name,
        ownerName: owner.full_name,
        rmName: activeRm?.name ?? null,
        order: priorityOrder,
        acceptUrl,
      })
      .catch((err) => {
        this.logger.error('Failed to send guardian invitation email', err);
        return null;
      });

    await this.notificationLog.logEmailSent({
      userId,
      recipientEmail: email,
      emailType: 'guardian_invitation',
      resendMessageId: messageId,
      metadata: { account_owner_id: ownerId, role: 'guardian', guardian_id: guardian.id },
    });

    this.activityService.log(
      ownerId,
      'guardian_invited',
      `Guardian invited — ${dto.name}`,
      { guardianId: guardian.id, membershipId: membership.id, email, priorityOrder },
    );
    this.posthog.capture(ownerId, 'guardian_invited', {
      relationship: dto.relationship,
      guardian_order: priorityOrder,
    });

    return {
      id: membership.id,
      guardian_id: guardian.id,
      role: 'guardian',
      invite_email: membership.invite_email,
      invite_name: membership.invite_name,
      status: membership.status,
      priority_order: priorityOrder,
      invitation_sent_at: membership.invitation_sent_at,
    };
  }

  // POST /invitations/recipient
  async inviteRecipient(ownerId: string, dto: InviteRecipientDto) {
    const email = dto.email.toLowerCase();
    const owner = await this.getOwner(ownerId);
    if (!owner) throw new NotFoundException('Account owner not found');

    const userId = await this.findExistingUserId(email);

    const { data: membership, error } = await this.supabase
      .getClient()
      .from('account_memberships')
      .insert({
        user_id: userId,
        account_owner_id: ownerId,
        role: 'recipient',
        status: 'pending',
        invite_email: email,
        invite_name: dto.name,
        relationship: dto.relationship,
        invitation_sent_at: new Date().toISOString(),
      })
      .select('id, invite_email, invite_name, status, invitation_token, invitation_sent_at')
      .single();

    if (error || !membership) {
      throw new InternalServerErrorException('Failed to add recipient.');
    }

    const { firstName, lastName } = splitName(dto.name);
    await this.recipientsService
      .create(ownerId, {
        firstName,
        lastName,
        email,
        phone: dto.phone,
        relationship: toRecipientRelationship(dto.relationship),
      })
      .catch((err) => {
        this.logger.error('Failed to sync recipients row', err);
      });

    const messageId = await this.emailService
      .sendRecipientNotification({
        to: email,
        recipientName: dto.name,
        ownerName: owner.full_name,
        signupUrl: `${this.frontendUrl}/signup?ref=recipient`,
      })
      .catch((err) => {
        this.logger.error('Failed to send recipient notification email', err);
        return null;
      });

    await this.notificationLog.logEmailSent({
      userId,
      recipientEmail: email,
      emailType: 'recipient_notification',
      resendMessageId: messageId,
      metadata: { account_owner_id: ownerId, role: 'recipient', membership_id: membership.id },
    });

    this.activityService.log(
      ownerId,
      'recipient_invited',
      `Recipient added — ${dto.name}`,
      { membershipId: membership.id, email, relationship: dto.relationship },
    );
    this.posthog.capture(ownerId, 'recipient_added', {
      relationship: dto.relationship,
    });

    return {
      id: membership.id,
      role: 'recipient',
      invite_email: membership.invite_email,
      invite_name: membership.invite_name,
      status: membership.status,
      invitation_sent_at: membership.invitation_sent_at,
    };
  }

  // GET /invitations/accept/:token
  async acceptInvitation(token: string, userId: string | null) {
    const { data: membership, error } = await this.supabase
      .getClient()
      .from('account_memberships')
      .select('id, role, status, invite_email, invite_name, account_owner_id')
      .eq('invitation_token', token)
      .maybeSingle();

    if (error || !membership) {
      throw new NotFoundException('Invitation not found');
    }

    if (membership.status === 'accepted' || membership.status === 'active') {
      return {
        alreadyAccepted: true,
        role: membership.role,
        loggedIn: !!userId,
      };
    }

    if (!userId) {
      return {
        alreadyAccepted: false,
        loggedIn: false,
        redirectUrl: `${this.frontendUrl}/auth/signup?invite_token=${token}&role=${membership.role}&name=${encodeURIComponent(
          membership.invite_name ?? '',
        )}`,
      };
    }

    // A logged-in user must be the actual invitee — otherwise anyone who
    // stumbles on an invite link while signed in could claim a stranger's
    // pending Release Manager/Guardian/Recipient membership.
    if (membership.invite_email) {
      const { data: authedUser } = await this.supabase
        .getClient()
        .from('users')
        .select('email')
        .eq('id', userId)
        .maybeSingle();

      if (!authedUser || authedUser.email.toLowerCase() !== membership.invite_email.toLowerCase()) {
        throw new ForbiddenException(
          'This invitation was sent to a different email address than the one you are signed in with.',
        );
      }
    }

    const { error: updateError } = await this.supabase
      .getClient()
      .from('account_memberships')
      .update({
        user_id: userId,
        status: 'accepted',
        invitation_accepted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', membership.id);

    if (updateError) {
      throw new InternalServerErrorException('Failed to accept invitation');
    }

    if (membership.role === 'guardian' && membership.invite_email) {
      const guardian = await this.guardiansService.findByEmail(
        membership.account_owner_id,
        membership.invite_email,
      );
      if (guardian) {
        await this.guardiansService.linkUser(guardian.id, userId).catch((err) => {
          this.logger.error('Failed to link guardian_user_id on accept', err);
        });
      }
    }

    if (membership.role === 'release_manager' && membership.invite_email) {
      await this.supabase.getClient()
        .from('release_managers')
        .update({
          rm_user_id: userId,
          status: 'accepted',
          accepted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('email', membership.invite_email)
        .eq('user_id', membership.account_owner_id)
        .not('status', 'in', '("revoked","declined")')
        .then(({ error }) => {
          if (error) this.logger.error('Failed to link rm_user_id on accept', error);
        });
    }

    this.activityService.log(userId, 'invitation_accepted', 'Invitation accepted', {
      membershipId: membership.id,
      role: membership.role,
    });
    this.posthog.capture(userId, 'invitation_accepted', { role: membership.role });

    return {
      alreadyAccepted: false,
      loggedIn: true,
      role: membership.role,
      redirectUrl: `${this.frontendUrl}${this.portalPathForRole(membership.role)}`,
    };
  }

  // Maps a membership role to its real frontend route. There is no generic
  // `/portal/{role}` route — only the release manager portal exists today
  // (under `/rm/*`); guardian/recipient fall back to the account picker.
  private portalPathForRole(role: string): string {
    if (role === 'owner') return '/dashboard';
    if (role === 'release_manager') return '/rm/overview';
    return '/select-account';
  }

  // POST /invitations/resend/:id
  async resendInvitation(ownerId: string, membershipId: string) {
    const { data: membership, error } = await this.supabase
      .getClient()
      .from('account_memberships')
      .select('id, role, invite_email, invite_name, invitation_token, status')
      .eq('id', membershipId)
      .eq('account_owner_id', ownerId)
      .maybeSingle();

    if (error || !membership) {
      throw new NotFoundException('Invitation not found');
    }

    if (!['pending'].includes(membership.status)) {
      throw new BadRequestException('Only pending invitations can be resent.');
    }

    const owner = await this.getOwner(ownerId);
    if (!owner) throw new NotFoundException('Account owner not found');

    const acceptUrl = `${this.frontendUrl}/invitations/accept/${membership.invitation_token}`;

    // Best-effort, like every other invitation email in this service — a
    // transient Resend error shouldn't fail the whole resend request.
    if (membership.role === 'release_manager') {
      await this.emailService
        .sendReleaseManagerInvitation({
          to: membership.invite_email,
          rmName: membership.invite_name,
          ownerName: owner.full_name,
          ownerEmail: owner.email,
          acceptUrl,
        })
        .catch((err) => {
          this.logger.error('Failed to resend RM invitation email', err);
        });
    } else if (membership.role === 'guardian') {
      const guardian = await this.guardiansService.findByEmail(
        ownerId,
        membership.invite_email,
      );
      await this.emailService
        .sendGuardianInvitation({
          to: membership.invite_email,
          guardianName: membership.invite_name,
          ownerName: owner.full_name,
          rmName: null,
          order: guardian?.priority_order ?? 1,
          acceptUrl,
        })
        .catch((err) => {
          this.logger.error('Failed to resend guardian invitation email', err);
        });
    } else {
      await this.emailService
        .sendRecipientNotification({
          to: membership.invite_email,
          recipientName: membership.invite_name,
          ownerName: owner.full_name,
          signupUrl: `${this.frontendUrl}/signup?ref=recipient`,
        })
        .catch((err) => {
          this.logger.error('Failed to resend recipient notification email', err);
        });
    }

    await this.supabase
      .getClient()
      .from('account_memberships')
      .update({
        invitation_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', membership.id);

    return { id: membership.id, resent: true };
  }

  // DELETE /invitations/:id
  async revokeInvitation(ownerId: string, membershipId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('account_memberships')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('id', membershipId)
      .eq('account_owner_id', ownerId)
      .select('id, role, invite_email')
      .maybeSingle();

    if (error || !data) {
      throw new NotFoundException('Invitation not found');
    }

    if (data.role === 'guardian' && data.invite_email) {
      const guardian = await this.guardiansService.findByEmail(ownerId, data.invite_email);
      if (guardian) {
        await this.guardiansService.revoke(guardian.id).catch((err) => {
          this.logger.error('Failed to revoke guardians row', err);
        });
      }
    } else if (data.role === 'release_manager' && data.invite_email) {
      const { error: rmError } = await this.supabase
        .getClient()
        .from('release_managers')
        .update({ status: 'revoked', updated_at: new Date().toISOString() })
        .eq('user_id', ownerId)
        .eq('email', data.invite_email)
        .not('status', 'in', '("revoked","declined")');
      if (rmError) this.logger.error('Failed to revoke release_managers row', rmError);
    } else if (data.role === 'recipient' && data.invite_email) {
      // The recipients table has no soft-revoke status in active use — mirror
      // the guardian-invite rollback pattern by removing the synced row
      // rather than leaving it referencing a revoked invitation.
      const { error: recipientError } = await this.supabase
        .getClient()
        .from('recipients')
        .delete()
        .eq('user_id', ownerId)
        .eq('email', data.invite_email.toLowerCase());
      if (recipientError) this.logger.error('Failed to remove recipients row', recipientError);
    }

    return { id: membershipId, revoked: true };
  }
}
