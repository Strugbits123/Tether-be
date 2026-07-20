import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service.js';

export type NotificationEmailType =
  | 'rm_invitation'
  | 'rm_reminder'
  | 'guardian_invitation'
  | 'recipient_notification';

@Injectable()
export class NotificationLogService {
  private readonly logger = new Logger(NotificationLogService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async logEmailSent(params: {
    userId?: string | null;
    recipientEmail: string;
    emailType: NotificationEmailType;
    resendMessageId: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.supabase.getClient().from('notification_log').insert({
        user_id: params.userId ?? null,
        recipient_email: params.recipientEmail,
        channel: 'email',
        email_type: params.emailType,
        resend_message_id: params.resendMessageId,
        status: 'sent',
        sent_at: new Date().toISOString(),
        metadata: params.metadata ?? {},
      });
    } catch (err) {
      this.logger.error('Failed to write notification_log row', err instanceof Error ? err.stack : err);
    }
  }

  async findByResendMessageId(resendMessageId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('notification_log')
      .select('id, user_id, recipient_email, email_type, status, metadata')
      .eq('resend_message_id', resendMessageId)
      .maybeSingle();

    if (error) {
      this.logger.error('Failed to look up notification_log row', error);
      return null;
    }
    return data;
  }

  async updateStatus(
    id: string,
    status: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await this.supabase
      .getClient()
      .from('notification_log')
      .update({ status, ...extra })
      .eq('id', id);
  }

  // Used for RM reminder rate-limiting: has a reminder been sent in the last
  // `hours` hours for this recipient email + email type?
  async wasSentRecently(
    recipientEmail: string,
    emailType: NotificationEmailType,
    hours: number,
  ): Promise<boolean> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('notification_log')
      .select('id')
      .eq('recipient_email', recipientEmail.toLowerCase())
      .eq('email_type', emailType)
      .gte('sent_at', since)
      .limit(1)
      .maybeSingle();

    if (error) {
      this.logger.error('Failed to check notification_log rate limit', error);
      return false;
    }
    return !!data;
  }
}
