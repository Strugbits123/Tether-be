import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { EmailService } from '../shared/email/email.service.js';
import { NotificationLogService } from '../shared/notification-log/notification-log.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { GuardiansService } from '../guardians/guardians.service.js';
import { AddRecipientDto } from './dto/add-recipient.dto.js';
import { UpdateRecipientDto } from './dto/update-recipient.dto.js';
import { ChangeReleaseManagerDto } from './dto/change-release-manager.dto.js';
import { DesignateGuardianDto } from './dto/designate-guardian.dto.js';

const CONTENT_TYPE_KEYS: Record<string, string> = {
  photo: 'photos',
  chapter: 'memoir_chapters',
  document: 'documents',
  message: 'messages',
};

// recipients.relationship is one of family/friend/other (see
// recipients/dto/create-recipient.dto.ts RelationshipType). content_assignments
// group_value uses the platform-wide GROUP_VALUES constant (family/friends/others)
// — this maps a recipient's own relationship to the group_value it inherits from.
function relationshipToGroupValue(relationship: string): string {
  if (relationship === 'family') return 'family';
  if (relationship === 'friend') return 'friends';
  return 'others';
}

function isFamilyRelationship(relationship: string): boolean {
  return relationship === 'family';
}

function emptyContentSummary() {
  return { photos: 0, memoir_chapters: 0, documents: 0, messages: 0, total: 0 };
}

@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly emailService: EmailService,
    private readonly notificationLog: NotificationLogService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
    private readonly guardiansService: GuardiansService,
    private readonly config: ConfigService,
  ) {}

  private get frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL') ?? 'https://app.jointether.com';
  }

  private async getOwner(ownerId: string) {
    const { data } = await this.supabase
      .getClient()
      .from('users')
      .select('id, full_name, email, onboarding')
      .eq('id', ownerId)
      .single();
    return data;
  }

  private async findExistingUserId(email: string): Promise<string | null> {
    const { data } = await this.supabase
      .getClient()
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .maybeSingle();
    return data?.id ?? null;
  }

  // Insert an account_memberships row, or reactivate a matching one if it
  // already exists (e.g. a previously revoked invite to the same email for
  // the same owner+role) — a plain insert would violate the unique_invite
  // constraint and fail silently if the caller doesn't check the error.
  // Always mints a fresh invitation_token so a stale/leaked link from a prior
  // invite can't still work. Returns the row's id + invitation_token.
  private async upsertMembership(params: {
    userId: string | null;
    ownerId: string;
    role: string;
    inviteEmail: string;
    inviteName: string;
    relationship: string;
    note?: string | null;
  }) {
    const { data: existing } = await this.supabase
      .getClient()
      .from('account_memberships')
      .select('id')
      .eq('account_owner_id', params.ownerId)
      .eq('role', params.role)
      .eq('invite_email', params.inviteEmail)
      .maybeSingle();

    const row = {
      user_id: params.userId,
      account_owner_id: params.ownerId,
      role: params.role,
      status: 'pending',
      invite_email: params.inviteEmail,
      invite_name: params.inviteName,
      relationship: params.relationship,
      note: params.note ?? null,
      invitation_token: randomUUID(),
      invitation_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = existing
      ? await this.supabase
          .getClient()
          .from('account_memberships')
          .update(row)
          .eq('id', existing.id)
          .select('id, invitation_token')
          .single()
      : await this.supabase
          .getClient()
          .from('account_memberships')
          .insert(row)
          .select('id, invitation_token')
          .single();

    if (error || !data) {
      throw new InternalServerErrorException('Failed to create invitation.');
    }

    return data;
  }

  private async getActiveReleaseManager(ownerId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('release_managers')
      .select(
        'id, name, email, phone, relationship, status, note, accepted_at, created_at',
      )
      .eq('user_id', ownerId)
      .not('status', 'in', '("revoked","declined")')
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException('Failed to fetch Release Manager.');
    }
    return data;
  }

  // GET /access/overview
  async getOverview(ownerId: string) {
    const owner = await this.getOwner(ownerId);
    if (!owner) throw new NotFoundException('Account owner not found');

    const [rm, guardians, recipientsRows, assignments] = await Promise.all([
      this.getActiveReleaseManager(ownerId),
      this.guardiansService.findActiveByOwner(ownerId),
      this.fetchRecipients(ownerId),
      this.fetchAssignments(ownerId),
    ]);

    const guardianByEmail = new Map(
      guardians.map((g) => [g.email.toLowerCase(), g]),
    );

    const family: any[] = [];
    const friendsAndOthers: any[] = [];

    for (const recipient of recipientsRows) {
      const guardian = guardianByEmail.get(recipient.email.toLowerCase());
      const member = {
        id: recipient.id,
        name: recipient.name,
        email: recipient.email,
        phone: recipient.phone,
        relationship: recipient.relationship,
        invitation_status: recipient.invitation_status,
        is_guardian: !!guardian,
        guardian_order: guardian?.priority_order ?? null,
        content_summary: this.computeContentSummary(assignments, recipient),
        created_at: recipient.created_at,
      };

      if (isFamilyRelationship(recipient.relationship)) {
        family.push(member);
      } else {
        friendsAndOthers.push(member);
      }
    }

    return {
      release_manager: rm
        ? {
            id: rm.id,
            name: rm.name,
            email: rm.email,
            phone: rm.phone,
            relationship: rm.relationship,
            status: rm.status,
            confirmed: rm.status === 'accepted' || rm.status === 'active',
            accepted_at: rm.accepted_at ?? null,
            created_at: rm.created_at,
          }
        : null,
      guardians: guardians.map((g) => ({
        id: g.id,
        recipient_id:
          recipientsRows.find((r) => r.email.toLowerCase() === g.email.toLowerCase())
            ?.id ?? null,
        name: g.name,
        email: g.email,
        relationship: g.relationship,
        status: g.status,
        priority_order: g.priority_order,
      })),
      recipients: {
        family: { count: family.length, members: family },
        friends_and_others: {
          count: friendsAndOthers.length,
          members: friendsAndOthers,
        },
      },
      stats: {
        total_recipients: recipientsRows.length,
        total_guardians: guardians.length,
        max_guardians: 3,
        has_release_manager: !!rm,
      },
      legal_disclaimer_accepted:
        (owner.onboarding as Record<string, unknown> | null)?.rm_legal_acknowledged ===
        true,
    };
  }

  private async fetchRecipients(ownerId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id, name, email, phone, relationship, note, invitation_status, created_at')
      .eq('user_id', ownerId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch recipients.');
    }
    return data ?? [];
  }

  private async fetchAssignments(ownerId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('content_assignments')
      .select('content_type, content_id, assignment_scope, group_value, recipient_id')
      .eq('user_id', ownerId);

    if (error) {
      throw new InternalServerErrorException('Failed to fetch content assignments.');
    }
    return data ?? [];
  }

  private computeContentSummary(
    assignments: Array<{
      content_type: string;
      content_id: string;
      assignment_scope: string;
      group_value: string | null;
      recipient_id: string | null;
    }>,
    recipient: { id: string; relationship: string },
  ) {
    const summary = emptyContentSummary();
    const groupValue = relationshipToGroupValue(recipient.relationship);
    const seen = new Set<string>(); // dedupe content_id per content_type

    for (const a of assignments) {
      const key = CONTENT_TYPE_KEYS[a.content_type];
      if (!key) continue;

      const matches =
        (a.assignment_scope === 'individual' && a.recipient_id === recipient.id) ||
        (a.assignment_scope === 'group' && a.group_value === groupValue) ||
        a.assignment_scope === 'all';

      if (!matches) continue;

      const dedupeKey = `${a.content_type}:${a.content_id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      (summary as any)[key] += 1;
      summary.total += 1;
    }

    return summary;
  }

  // GET /access/recipients/:id/content
  async getRecipientContent(ownerId: string, recipientId: string) {
    const recipient = await this.getOwnedRecipient(ownerId, recipientId);
    const assignments = await this.fetchAssignments(ownerId);
    const groupValue = relationshipToGroupValue(recipient.relationship);

    const seen = new Set<string>();
    const countsByType: Record<string, number> = {
      photo: 0,
      chapter: 0,
      document: 0,
      message: 0,
    };
    let individualCount = 0;
    let viaGroup = false;
    let viaAll = false;

    for (const a of assignments) {
      const matchesIndividual =
        a.assignment_scope === 'individual' && a.recipient_id === recipient.id;
      const matchesGroup = a.assignment_scope === 'group' && a.group_value === groupValue;
      const matchesAll = a.assignment_scope === 'all';

      if (!matchesIndividual && !matchesGroup && !matchesAll) continue;

      const dedupeKey = `${a.content_type}:${a.content_id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      if (countsByType[a.content_type] !== undefined) {
        countsByType[a.content_type] += 1;
      }
      if (matchesIndividual) individualCount += 1;
      if (matchesGroup) viaGroup = true;
      if (matchesAll) viaAll = true;
    }

    const totalItems = Object.values(countsByType).reduce((sum, n) => sum + n, 0);

    const assignmentScopes: Array<Record<string, unknown>> = [];
    if (viaGroup) assignmentScopes.push({ scope: 'group', group_value: groupValue });
    if (viaAll) assignmentScopes.push({ scope: 'all' });
    if (individualCount > 0) {
      assignmentScopes.push({ scope: 'individual', count: individualCount });
    }

    return {
      recipient_id: recipientId,
      assignments: Object.entries(countsByType).map(([content_type, count]) => ({
        content_type,
        count,
      })),
      total_items: totalItems,
      assignment_scopes: assignmentScopes,
    };
  }

  private async getOwnedRecipient(ownerId: string, recipientId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id, name, email, phone, relationship, invitation_status, created_at')
      .eq('id', recipientId)
      .eq('user_id', ownerId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException('Failed to fetch recipient.');
    }
    if (!data) {
      throw new NotFoundException('Recipient not found');
    }
    return data;
  }

  // POST /access/recipients
  async addRecipient(ownerId: string, dto: AddRecipientDto) {
    const email = dto.email.toLowerCase();
    const owner = await this.getOwner(ownerId);
    if (!owner) throw new NotFoundException('Account owner not found');

    const { data: existing } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id')
      .eq('user_id', ownerId)
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      throw new ConflictException(
        'A recipient with this email address already exists on your account.',
      );
    }

    // Validate the guardian designation up front — before persisting anything
    // — so a rejected request never leaves an orphaned recipient/membership
    // with no matching guardian record.
    if (dto.designate_as_guardian) {
      if (dto.legal_acknowledged !== true) {
        throw new BadRequestException('legal_acknowledged must be true');
      }
      const guardianCount = await this.guardiansService.countActiveByOwner(ownerId);
      if (guardianCount >= 3) {
        throw new ConflictException('Maximum of 3 Guardians already designated.');
      }
    }

    const name = `${dto.first_name.trim()} ${dto.last_name.trim()}`;
    const userId = await this.findExistingUserId(email);

    const { data: recipient, error } = await this.supabase
      .getClient()
      .from('recipients')
      .insert({
        user_id: ownerId,
        name,
        email,
        phone: dto.phone ?? null,
        relationship: dto.relationship,
        note: dto.note ?? null,
      })
      .select('id, name, email, phone, relationship, note, invitation_status, created_at')
      .single();

    if (error || !recipient) {
      throw new InternalServerErrorException('Failed to add recipient.');
    }

    await this.upsertMembership({
      userId,
      ownerId,
      role: 'recipient',
      inviteEmail: email,
      inviteName: name,
      relationship: dto.relationship,
    });

    let guardianResult: any = null;
    if (dto.designate_as_guardian) {
      guardianResult = await this.designateGuardianInternal(ownerId, owner, recipient, {
        priority_order: undefined,
      });
    }

    const messageId = await this.emailService
      .sendRecipientNotification({
        to: email,
        recipientName: name,
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
      metadata: { account_owner_id: ownerId, role: 'recipient', recipient_id: recipient.id },
    });

    this.activityService.log(ownerId, 'recipient_added', `${name} added as recipient`, {
      recipientId: recipient.id,
      name,
      relationship: dto.relationship,
    });
    this.posthog.capture(ownerId, 'recipient_added', { relationship: dto.relationship });

    return {
      ...recipient,
      is_guardian: !!guardianResult,
      guardian_order: guardianResult?.priority_order ?? null,
      content_summary: emptyContentSummary(),
    };
  }

  // PATCH /access/recipients/:id
  async updateRecipient(ownerId: string, recipientId: string, dto: UpdateRecipientDto) {
    const recipient = await this.getOwnedRecipient(ownerId, recipientId);

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.phone !== undefined) updates.phone = dto.phone;
    if (dto.relationship !== undefined) updates.relationship = dto.relationship;

    const newEmail = dto.email?.toLowerCase();
    if (newEmail && newEmail !== recipient.email.toLowerCase()) {
      const { data: conflicting } = await this.supabase
        .getClient()
        .from('recipients')
        .select('id')
        .eq('user_id', ownerId)
        .eq('email', newEmail)
        .neq('id', recipientId)
        .maybeSingle();

      if (conflicting) {
        throw new ConflictException(
          'A recipient with this email address already exists on your account.',
        );
      }

      updates.email = newEmail;

      await this.supabase
        .getClient()
        .from('account_memberships')
        .update({ invite_email: newEmail, updated_at: new Date().toISOString() })
        .eq('account_owner_id', ownerId)
        .eq('role', 'recipient')
        .eq('invite_email', recipient.email.toLowerCase());

      const guardian = await this.guardiansService.findByEmail(ownerId, recipient.email);
      if (guardian) {
        await this.supabase
          .getClient()
          .from('guardians')
          .update({ email: newEmail, updated_at: new Date().toISOString() })
          .eq('id', guardian.id);
      }
    }

    const { data: updated, error } = await this.supabase
      .getClient()
      .from('recipients')
      .update(updates)
      .eq('id', recipientId)
      .eq('user_id', ownerId)
      .select('id, name, email, phone, relationship, invitation_status, created_at')
      .single();

    if (error || !updated) {
      throw new InternalServerErrorException('Failed to update recipient.');
    }

    this.activityService.log(ownerId, 'recipient_updated', `Recipient updated — ${updated.name}`, {
      recipientId: updated.id,
      fields_updated: Object.keys(updates).filter((k) => k !== 'updated_at'),
    });

    return updated;
  }

  // DELETE /access/recipients/:id
  async removeRecipient(ownerId: string, recipientId: string) {
    const recipient = await this.getOwnedRecipient(ownerId, recipientId);

    const guardian = await this.guardiansService.findByEmail(ownerId, recipient.email);
    if (guardian) {
      await this.guardiansService.revoke(guardian.id);
      await this.supabase
        .getClient()
        .from('account_memberships')
        .update({ status: 'revoked', updated_at: new Date().toISOString() })
        .eq('account_owner_id', ownerId)
        .eq('role', 'guardian')
        .eq('invite_email', recipient.email.toLowerCase());
    }

    await this.supabase
      .getClient()
      .from('content_assignments')
      .delete()
      .eq('user_id', ownerId)
      .eq('recipient_id', recipientId);

    await this.supabase
      .getClient()
      .from('account_memberships')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('account_owner_id', ownerId)
      .eq('role', 'recipient')
      .eq('invite_email', recipient.email.toLowerCase());

    const { error } = await this.supabase
      .getClient()
      .from('recipients')
      .delete()
      .eq('id', recipientId)
      .eq('user_id', ownerId);

    if (error) {
      throw new InternalServerErrorException('Failed to remove recipient.');
    }

    this.activityService.log(ownerId, 'recipient_removed', `Recipient removed — ${recipient.name}`, {
      recipientId,
      name: recipient.name,
    });
    this.posthog.capture(ownerId, 'recipient_removed', { recipientId });

    return { message: 'Recipient removed successfully' };
  }

  // POST /access/recipients/:id/guardian
  async designateGuardian(ownerId: string, recipientId: string, dto: DesignateGuardianDto) {
    if (dto.legal_acknowledged !== true) {
      throw new BadRequestException('legal_acknowledged must be true');
    }

    const owner = await this.getOwner(ownerId);
    if (!owner) throw new NotFoundException('Account owner not found');

    const recipient = await this.getOwnedRecipient(ownerId, recipientId);

    const existingGuardian = await this.guardiansService.findByEmail(ownerId, recipient.email);
    if (existingGuardian) {
      throw new ConflictException('This recipient is already a Guardian.');
    }

    const guardian = await this.designateGuardianInternal(ownerId, owner, recipient, dto);

    return {
      id: guardian.id,
      name: guardian.name,
      priority_order: guardian.priority_order,
      status: guardian.status,
    };
  }

  private async designateGuardianInternal(
    ownerId: string,
    owner: { id: string; full_name: string; email: string },
    recipient: { id: string; name: string; email: string; relationship: string },
    dto: { priority_order?: number },
  ) {
    const count = await this.guardiansService.countActiveByOwner(ownerId);
    if (count >= 3) {
      throw new ConflictException('Maximum of 3 Guardians already designated.');
    }

    const priorityOrder =
      dto.priority_order ?? (await this.guardiansService.nextPriorityOrder(ownerId));

    const userId = await this.findExistingUserId(recipient.email);

    const guardian = await this.guardiansService.create({
      accountId: ownerId,
      name: recipient.name,
      email: recipient.email,
      relationship: recipient.relationship,
      priorityOrder,
      userId,
    });

    await this.upsertMembership({
      userId,
      ownerId,
      role: 'guardian',
      inviteEmail: recipient.email.toLowerCase(),
      inviteName: recipient.name,
      relationship: recipient.relationship,
    });

    const rm = await this.getActiveReleaseManager(ownerId);
    const acceptUrl = `${this.frontendUrl}/invitations/accept/${guardian.invitation_token}`;
    const messageId = await this.emailService
      .sendGuardianInvitation({
        to: recipient.email,
        guardianName: recipient.name,
        ownerName: owner.full_name,
        rmName: rm?.name ?? null,
        order: priorityOrder,
        acceptUrl,
      })
      .catch((err) => {
        this.logger.error('Failed to send guardian invitation email', err);
        return null;
      });

    await this.notificationLog.logEmailSent({
      userId,
      recipientEmail: recipient.email,
      emailType: 'guardian_invitation',
      resendMessageId: messageId,
      metadata: { account_owner_id: ownerId, role: 'guardian', guardian_id: guardian.id },
    });

    this.activityService.log(
      ownerId,
      'guardian_designated',
      `Guardian designated — ${recipient.name}`,
      { guardianId: guardian.id, recipientId: recipient.id, priorityOrder },
    );
    this.posthog.capture(ownerId, 'guardian_designated', { priority_order: priorityOrder });

    return guardian;
  }

  // DELETE /access/recipients/:id/guardian
  async removeGuardianDesignation(ownerId: string, recipientId: string) {
    const recipient = await this.getOwnedRecipient(ownerId, recipientId);

    const guardian = await this.guardiansService.findByEmail(ownerId, recipient.email);
    if (!guardian) {
      throw new NotFoundException('Guardian designation not found');
    }

    await this.guardiansService.revoke(guardian.id);

    await this.supabase
      .getClient()
      .from('account_memberships')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('account_owner_id', ownerId)
      .eq('role', 'guardian')
      .eq('invite_email', recipient.email.toLowerCase());

    this.activityService.log(
      ownerId,
      'guardian_removed',
      `Guardian designation removed — ${recipient.name}`,
      { guardianId: guardian.id, recipientId },
    );

    return { message: 'Guardian designation removed' };
  }

  // POST /access/release-manager
  async setReleaseManager(ownerId: string, dto: ChangeReleaseManagerDto) {
    if (dto.legal_acknowledged !== true) {
      throw new BadRequestException('legal_acknowledged must be true');
    }

    const owner = await this.getOwner(ownerId);
    if (!owner) throw new NotFoundException('Account owner not found');

    const email = dto.email.toLowerCase();

    const { data: recipientConflict } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id')
      .eq('user_id', ownerId)
      .eq('email', email)
      .maybeSingle();

    if (recipientConflict) {
      throw new ConflictException(
        'This person is already a recipient on your account. A Release Manager cannot also be a recipient.',
      );
    }

    const existingRm = await this.getActiveReleaseManager(ownerId);
    const replaced = !!existingRm;

    if (existingRm) {
      await this.supabase
        .getClient()
        .from('release_managers')
        .update({
          status: 'revoked',
          revoked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', ownerId)
        .not('status', 'in', '("revoked","declined")');

      await this.supabase
        .getClient()
        .from('account_memberships')
        .update({ status: 'revoked', updated_at: new Date().toISOString() })
        .eq('account_owner_id', ownerId)
        .eq('role', 'release_manager')
        .not('status', 'in', '("revoked","declined")');
    }

    const userId = await this.findExistingUserId(email);

    const { data: rm, error } = await this.supabase
      .getClient()
      .from('release_managers')
      .insert({
        user_id: ownerId,
        name: dto.name,
        email,
        phone: dto.phone ?? null,
        relationship: dto.relationship,
        note: dto.note ?? null,
        status: 'invited',
      })
      .select('id, name, email, phone, relationship, note, status, created_at')
      .single();

    if (error || !rm) {
      throw new InternalServerErrorException('Failed to designate Release Manager.');
    }

    const membership = await this.upsertMembership({
      userId,
      ownerId,
      role: 'release_manager',
      inviteEmail: email,
      inviteName: dto.name,
      relationship: dto.relationship,
      note: dto.note,
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
      metadata: { account_owner_id: ownerId, role: 'release_manager', rm_id: rm.id },
    });

    await this.supabase
      .getClient()
      .from('users')
      .update({
        onboarding: {
          ...((owner.onboarding as Record<string, unknown>) ?? {}),
          rm_legal_acknowledged: true,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', ownerId);

    this.activityService.log(ownerId, 'release_manager_set', `Release Manager set — ${dto.name}`, {
      rmId: rm.id,
      name: dto.name,
      email,
      replaced,
    });
    this.posthog.capture(ownerId, 'release_manager_set', { replaced });

    return rm;
  }

  // POST /access/release-manager/remind
  async remindReleaseManager(ownerId: string) {
    const owner = await this.getOwner(ownerId);
    if (!owner) throw new NotFoundException('Account owner not found');

    const rm = await this.getActiveReleaseManager(ownerId);
    if (!rm) {
      throw new NotFoundException('No Release Manager designated for this account.');
    }
    if (rm.status !== 'invited') {
      throw new BadRequestException('This Release Manager has already responded.');
    }

    const alreadySent = await this.notificationLog.wasSentRecently(rm.email, 'rm_reminder', 24);
    if (alreadySent) {
      throw new HttpException(
        'A reminder was already sent to this Release Manager in the last 24 hours.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const userId = await this.findExistingUserId(rm.email);

    const { data: membership } = await this.supabase
      .getClient()
      .from('account_memberships')
      .select('invitation_token')
      .eq('account_owner_id', ownerId)
      .eq('role', 'release_manager')
      .eq('invite_email', rm.email.toLowerCase())
      .not('status', 'in', '("revoked","declined")')
      .maybeSingle();

    if (!membership?.invitation_token) {
      throw new InternalServerErrorException(
        'No pending invitation found for this Release Manager.',
      );
    }

    const acceptUrl = `${this.frontendUrl}/invitations/accept/${membership.invitation_token}`;
    const messageId = await this.emailService
      .sendReleaseManagerReminder({
        to: rm.email,
        rmName: rm.name,
        ownerName: owner.full_name,
        acceptUrl,
      })
      .catch((err) => {
        this.logger.error('Failed to send RM reminder email', err);
        return null;
      });

    await this.notificationLog.logEmailSent({
      userId,
      recipientEmail: rm.email,
      emailType: 'rm_reminder',
      resendMessageId: messageId,
      metadata: { account_owner_id: ownerId, role: 'release_manager', rm_id: rm.id },
    });

    this.activityService.log(ownerId, 'release_manager_reminder_sent', `Reminder sent — ${rm.name}`, {
      rmId: rm.id,
      name: rm.name,
    });

    return { message: `Reminder sent to ${rm.name}` };
  }
}
