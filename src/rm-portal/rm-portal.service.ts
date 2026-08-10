import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { NotificationLogService } from '../shared/notification-log/notification-log.service.js';
import { EmailService } from '../shared/email/email.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { RetryEmailDto } from './dto/retry-email.dto.js';
import { computeContentSummary, timeAgo } from './rm-portal.util.js';
import { resolveOwnerName } from '../shared/owner-name.util.js';

// activity_log event_types worth surfacing to the RM. Minor content edits
// (autosave, reorder, transcription progress, etc.) are intentionally excluded.
const RM_VISIBLE_EVENT_TYPES = new Set([
  'release_manager_invited',
  'release_manager_set',
  'invitation_accepted',
  'guardian_invited',
  'guardian_designated',
  'recipient_added',
  'recipient_removed',
  'chapter_status_changed',
  'profile_completed',
  'email_bounced',
]);

@Injectable()
export class RmPortalService {
  private readonly logger = new Logger(RmPortalService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly notificationLog: NotificationLogService,
    private readonly emailService: EmailService,
    private readonly activityService: ActivityService,
  ) {}

  // GET /rm/overview
  async getOverview(accountOwnerId: string) {
    const { data: owner, error } = await this.supabase
      .getClient()
      .from('users')
      .select('id, full_name, first_name, last_name, avatar_url, email')
      .eq('id', accountOwnerId)
      .single();

    if (error || !owner) {
      throw new NotFoundException('Account owner not found');
    }

    // full_name is blank for any owner who never finished their profile — see
    // resolveOwnerName, which is now the single place this fallback lives.
    const ownerDisplayName = resolveOwnerName(owner, 'Account Owner');

    const supabase = this.supabase.getClient();

    const [
      { data: messages },
      { count: documentCount },
      { count: photoCount },
      { count: chapterCount },
      { count: recipientCount },
      { data: activityRows },
      { data: activePlan },
    ] = await Promise.all([
      supabase.from('messages').select('type').eq('user_id', accountOwnerId),
      supabase
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', accountOwnerId),
      supabase
        .from('photos')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', accountOwnerId),
      supabase
        .from('chapters')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', accountOwnerId)
        .neq('status', 'draft'),
      supabase
        .from('recipients')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', accountOwnerId),
      supabase
        .from('activity_log')
        .select('id, event_type, event_label, created_at')
        .eq('user_id', accountOwnerId)
        .in('event_type', [...RM_VISIBLE_EVENT_TYPES])
        .order('created_at', { ascending: false })
        .limit(10),
      supabase
        .from('release_plans')
        .select('id')
        .eq('user_id', accountOwnerId)
        .eq('status', 'active')
        .maybeSingle(),
    ]);

    const videoMessages = (messages ?? []).filter((m) => m.type === 'video').length;
    const audioMessages = (messages ?? []).filter((m) => m.type === 'audio').length;

    const recentActivity = (activityRows ?? [])
      .map((a) => ({
        id: a.id,
        event_type: a.event_type,
        event_label: a.event_label,
        created_at: a.created_at,
        time_ago: timeAgo(a.created_at),
      }));

    return {
      account_owner: {
        id: owner.id,
        name: ownerDisplayName,
        avatar_url: owner.avatar_url ?? null,
      },
      content_stats: {
        video_messages: videoMessages,
        audio_messages: audioMessages,
        documents: documentCount ?? 0,
        photos: photoCount ?? 0,
        memoir_chapters: chapterCount ?? 0,
        recipients: recipientCount ?? 0,
      },
      recent_activity: recentActivity,
      has_active_release: !!activePlan,
    };
  }

  // GET /rm/recipients
  async listRecipients(accountOwnerId: string) {
    const [{ data: recipients, error }, assignments, activePlan] = await Promise.all([
      this.supabase
        .getClient()
        .from('recipients')
        .select('id, name, email, phone, relationship, invitation_status, created_at')
        .eq('user_id', accountOwnerId)
        .order('created_at', { ascending: true }),
      this.fetchAssignments(accountOwnerId),
      this.getActiveReleasePlan(accountOwnerId),
    ]);

    if (error) {
      throw new InternalServerErrorException('Failed to fetch recipients.');
    }

    const rows = recipients ?? [];
    const deliveryByRecipient = activePlan
      ? await this.fetchDeliveryStatusMap(activePlan.id)
      : new Map();

    const result = rows.map((r) => {
      const delivery = deliveryByRecipient.get(r.id);
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        relationship: r.relationship,
        content_count: computeContentSummary(assignments, r),
        delivery: delivery
          ? {
              email_status: delivery.email_status,
              portal_status: this.derivePortalStatus(delivery),
              portal_first_accessed_at: delivery.portal_first_accessed_at ?? null,
            }
          : null,
      };
    });

    return {
      recipients: result,
      total: result.length,
      release_plan_active: !!activePlan,
      release_plan_status: activePlan?.status ?? null,
    };
  }

  // GET /rm/recipients/:id
  async getRecipient(accountOwnerId: string, recipientId: string) {
    const { data: recipient, error } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id, name, email, phone, relationship, invitation_status, created_at')
      .eq('id', recipientId)
      .eq('user_id', accountOwnerId)
      .maybeSingle();

    if (error || !recipient) {
      throw new NotFoundException('Recipient not found');
    }

    const assignments = await this.fetchAssignments(accountOwnerId);
    const activePlan = await this.getActiveReleasePlan(accountOwnerId);

    let delivery: any = null;
    let deliveryEvents: any[] = [];
    if (activePlan) {
      const deliveryMap = await this.fetchDeliveryStatusMap(activePlan.id);
      const row = deliveryMap.get(recipientId);
      if (row) {
        delivery = {
          email_status: row.email_status,
          email_bounced_at: row.email_bounced_at ?? null,
          portal_unlocked_at: row.portal_unlocked_at ?? null,
          portal_first_accessed_at: row.portal_first_accessed_at ?? null,
          portal_status: this.derivePortalStatus(row),
        };
      }

      // Correlate by the identifiers stored in metadata at send-time, not by
      // email — a shared/rename email could otherwise surface another
      // account's or another release plan's notification history.
      const { data: logRows } = await this.supabase
        .getClient()
        .from('notification_log')
        .select('id, email_type, status, sent_at, delivered_at, bounced_at, opened_at, metadata')
        .contains('metadata', {
          account_owner_id: accountOwnerId,
          release_plan_id: activePlan.id,
          recipient_id: recipientId,
        })
        .order('sent_at', { ascending: false });
      deliveryEvents = logRows ?? [];
    }

    return {
      ...recipient,
      content_summary: computeContentSummary(assignments, recipient),
      delivery,
      delivery_events: deliveryEvents,
    };
  }

  // PATCH /rm/recipients/:id/retry-email
  async retryRecipientEmail(
    accountOwnerId: string,
    recipientId: string,
    dto: RetryEmailDto,
  ) {
    const activePlan = await this.getActiveReleasePlan(accountOwnerId);
    if (!activePlan) {
      throw new NotFoundException('No active release plan for this account.');
    }

    const { data: deliveryRow, error } = await this.supabase
      .getClient()
      .from('recipient_delivery_status')
      .select('id, recipient_id, email_status')
      .eq('release_plan_id', activePlan.id)
      .eq('recipient_id', recipientId)
      .maybeSingle();

    if (error || !deliveryRow) {
      throw new NotFoundException('Delivery record not found for this recipient.');
    }
    if (deliveryRow.email_status !== 'bounced') {
      throw new NotFoundException('This recipient has no bounced delivery to retry.');
    }

    const { data: recipient } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id, name')
      .eq('id', recipientId)
      .eq('user_id', accountOwnerId)
      .single();

    const { data: owner } = await this.supabase
      .getClient()
      .from('users')
      .select('full_name')
      .eq('id', accountOwnerId)
      .single();

    const newEmail = dto.email.toLowerCase();
    const frontendUrl = process.env.FRONTEND_URL ?? 'https://app.jointether.com';
    const portalUrl = `${frontendUrl}/portal/${activePlan.id}/${recipientId}`;

    let messageId: string | null;
    try {
      messageId = await this.emailService.sendDeliveryEmail({
        to: newEmail,
        recipientName: recipient?.name ?? 'there',
        ownerName: resolveOwnerName(owner),
        portalUrl,
      });
    } catch (err) {
      this.logger.error(`Failed to resend delivery email for recipient ${recipientId}`, err);
      throw new InternalServerErrorException(
        'Failed to send the delivery email. Please try again.',
      );
    }

    // The email has now been sent — an irreversible external side effect. Move
    // the row off 'bounced' immediately, before any other bookkeeping, so a
    // failure below can't leave the delivery looking retryable and invite a
    // duplicate send when the client retries after a 500.
    const { error: statusError } = await this.supabase
      .getClient()
      .from('recipient_delivery_status')
      .update({
        retry_email: newEmail,
        email_status: 'sent',
        updated_at: new Date().toISOString(),
      })
      .eq('id', deliveryRow.id);

    if (statusError) {
      // Deliberately not a 500: the email did go out, and reporting failure
      // here is what would trigger the duplicate retry. Loudly logged instead.
      this.logger.error(
        `Delivery email resent to ${newEmail} but recipient_delivery_status ${deliveryRow.id} was not updated — retry state may be stale`,
        statusError,
      );
    }

    // Everything past this point is bookkeeping. None of it is worth failing
    // the request over now that the send has happened and been recorded.
    try {
      await this.notificationLog.logEmailSent({
        recipientEmail: newEmail,
        emailType: 'recipient_notification',
        resendMessageId: messageId,
        metadata: { account_owner_id: accountOwnerId, release_plan_id: activePlan.id, recipient_id: recipientId },
      });

      await this.supabase
        .getClient()
        .from('recipients')
        .update({ email: newEmail, updated_at: new Date().toISOString() })
        .eq('id', recipientId);

      await this.supabase.getClient().from('release_plan_activity_log').insert({
        release_plan_id: activePlan.id,
        event_type: 'delivery_email_retried',
        event_label: `Delivery email resent to ${recipient?.name ?? 'recipient'} at ${newEmail}`,
        actor_role: 'release_manager',
      });

      this.activityService.log(
        accountOwnerId,
        'delivery_email_retried',
        `Delivery email resent — ${recipient?.name ?? 'recipient'}`,
        { recipientId, newEmail },
      );
    } catch (err) {
      this.logger.error(
        `Post-send bookkeeping failed after resending delivery email to ${newEmail}`,
        err,
      );
    }

    return {
      message: `Delivery email resent to ${newEmail}`,
      email_status: 'sent',
    };
  }

  private derivePortalStatus(delivery: {
    email_status: string;
    portal_first_accessed_at?: string | null;
  }): string {
    if (delivery.portal_first_accessed_at) return 'accessed';
    if (delivery.email_status === 'bounced') return 'bounced';
    if (delivery.email_status === 'sent' || delivery.email_status === 'delivered') {
      return 'delivered';
    }
    return delivery.email_status;
  }

  async getActiveReleasePlan(accountOwnerId: string) {
    const { data } = await this.supabase
      .getClient()
      .from('release_plans')
      .select('*')
      .eq('user_id', accountOwnerId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  }

  async fetchDeliveryStatusMap(releasePlanId: string) {
    const { data } = await this.supabase
      .getClient()
      .from('recipient_delivery_status')
      .select(
        'recipient_id, email_status, email_bounced_at, portal_unlocked_at, portal_first_accessed_at, retry_email',
      )
      .eq('release_plan_id', releasePlanId);

    return new Map((data ?? []).map((row) => [row.recipient_id, row]));
  }

  private async fetchAssignments(accountOwnerId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('content_assignments')
      .select('content_type, content_id, assignment_scope, group_value, recipient_id')
      .eq('user_id', accountOwnerId);

    if (error) {
      throw new InternalServerErrorException('Failed to fetch content assignments.');
    }
    return data ?? [];
  }
}
