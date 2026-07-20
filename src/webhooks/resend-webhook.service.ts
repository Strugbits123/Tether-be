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

    await this.notificationLog.updateStatus(log.id, 'bounced', {
      bounced_at: new Date().toISOString(),
      error_message: bounceReason,
    });

    const metadata = (log.metadata ?? {}) as Record<string, unknown>;
    const ownerId = (metadata.account_owner_id as string) ?? null;

    if (log.email_type === 'rm_invitation' || log.email_type === 'rm_reminder') {
      await this.supabase
        .getClient()
        .from('release_managers')
        .update({ status: 'bounced', updated_at: new Date().toISOString() })
        .eq('user_id', ownerId)
        .eq('email', log.recipient_email);

      if (ownerId) {
        await this.activityService.log(
          ownerId,
          'email_bounced',
          `Release Manager invitation bounced — ${log.recipient_email}`,
          { notificationLogId: log.id, email: log.recipient_email, emailType: log.email_type },
        );
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
