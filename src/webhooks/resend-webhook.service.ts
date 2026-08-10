import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { NotificationLogService } from '../shared/notification-log/notification-log.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { GuardiansService } from '../guardians/guardians.service.js';

interface ResendEmailEventData {
  email_id: string;
  to?: string[];
  bounce?: { message?: string; type?: string };
}

@Injectable()
export class ResendWebhookService {
  private readonly logger = new Logger(ResendWebhookService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly notificationLog: NotificationLogService,
    private readonly activityService: ActivityService,
    private readonly guardiansService: GuardiansService,
  ) {}

  async handleDelivered(data: ResendEmailEventData) {
    const log = await this.notificationLog.findByResendMessageId(data.email_id);
    if (!log) return;
    await this.notificationLog.updateStatus(log.id, 'delivered', {
      delivered_at: new Date().toISOString(),
    });
  }

  async handleOpened(data: ResendEmailEventData) {
    const log = await this.notificationLog.findByResendMessageId(data.email_id);
    if (!log) return;
    await this.notificationLog.updateStatus(log.id, 'opened', {
      opened_at: new Date().toISOString(),
    });
  }

  async handleBounced(data: ResendEmailEventData) {
    const log = await this.notificationLog.findByResendMessageId(data.email_id);
    if (!log) {
      this.logger.warn(`No notification_log row for bounced email ${data.email_id}`);
      return;
    }

    const bounceReason = data.bounce?.message ?? data.bounce?.type ?? 'Email bounced';

    // Resend can redeliver the same webhook event, and a plain
    // read-status-then-update would let two concurrent deliveries both observe
    // 'sent' and both re-run the release_managers/guardians update and re-log
    // activity. Claim the transition atomically and let only the winner
    // continue; a replay (or the loser of the race) is a no-op.
    const claimed = await this.notificationLog.claimStatusTransition(
      log.id,
      'bounced',
      {
        bounced_at: new Date().toISOString(),
        error_message: bounceReason,
      },
    );

    if (!claimed) {
      return;
    }

    const metadata = (log.metadata ?? {}) as Record<string, unknown>;
    const ownerId = (metadata.account_owner_id as string) ?? null;

    if (log.email_type === 'rm_invitation' || log.email_type === 'rm_reminder') {
      // Mirror the guardian branch's resilience: fall back to an email-only
      // lookup when account_owner_id wasn't captured in metadata, instead of
      // silently matching nothing on a null user_id filter.
      let resolvedOwnerId = ownerId;
      if (!resolvedOwnerId) {
        const { data: rm } = await this.supabase
          .getClient()
          .from('release_managers')
          .select('user_id')
          .eq('email', log.recipient_email)
          .not('status', 'in', '("revoked","declined")')
          .maybeSingle();
        resolvedOwnerId = (rm?.user_id as string) ?? null;
      }

      if (resolvedOwnerId) {
        await this.supabase
          .getClient()
          .from('release_managers')
          .update({ status: 'bounced', updated_at: new Date().toISOString() })
          .eq('user_id', resolvedOwnerId)
          .eq('email', log.recipient_email);

        await this.activityService.log(
          resolvedOwnerId,
          'email_bounced',
          `Release Manager invitation bounced — ${log.recipient_email}`,
          { notificationLogId: log.id, email: log.recipient_email, emailType: log.email_type },
        );
      } else {
        this.logger.warn(`Could not resolve account owner for bounced RM email ${log.recipient_email}`);
      }
    } else if (log.email_type === 'guardian_invitation') {
      const guardianId = metadata.guardian_id as string | undefined;
      if (guardianId) {
        await this.guardiansService.markBounced(guardianId);
      } else if (ownerId) {
        const guardian = await this.guardiansService.findByEmail(ownerId, log.recipient_email);
        if (guardian) await this.guardiansService.markBounced(guardian.id);
      }

      if (ownerId) {
        await this.activityService.log(
          ownerId,
          'email_bounced',
          `Guardian invitation bounced — ${log.recipient_email}`,
          { notificationLogId: log.id, email: log.recipient_email, emailType: log.email_type },
        );
      }
    } else if (ownerId) {
      await this.activityService.log(
        ownerId,
        'email_bounced',
        `Notification email bounced — ${log.recipient_email}`,
        { notificationLogId: log.id, email: log.recipient_email, emailType: log.email_type },
      );
    }
  }
}
