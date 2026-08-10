import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service.js';

export type NotificationEmailType =
  | 'rm_invitation'
  | 'rm_reminder'
  | 'guardian_invitation'
  | 'recipient_notification'
  // Resends of any of the invitation types above. Kept distinct so the resend
  // rate-limit window doesn't count the original send, and vice versa.
  | 'invitation_resend';

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
        recipient_email: params.recipientEmail.toLowerCase(),
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

  /**
   * Atomically move a row to `status` only if it isn't already there, returning
   * whether THIS call won. Callers run their side effects only on a true result.
   *
   * Replaces read-then-check-then-write for webhook replay protection: Resend
   * can redeliver the same event, and two concurrent deliveries would both
   * observe the pre-transition status and both proceed. The conditional update
   * plus RETURNING makes exactly one of them the winner.
   */
  async claimStatusTransition(
    id: string,
    status: string,
    extra?: Record<string, unknown>,
  ): Promise<boolean> {
    const { data, error } = await this.supabase
      .getClient()
      .from('notification_log')
      .update({ status, ...extra })
      .eq('id', id)
      .neq('status', status)
      .select('id');

    if (error) {
      this.logger.error('Failed to claim notification_log status', error);
      return false;
    }
    return (data?.length ?? 0) > 0;
  }

  async updateStatus(
    id: string,
    status: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.supabase
      .getClient()
      .from('notification_log')
      .update({ status, ...extra })
      .eq('id', id);

    // ResendWebhookService.handleBounced depends on this write landing — it
    // treats status === 'bounced' as the replay guard on the next delivery of
    // the same event. A silent failure here means the bounce is reprocessed
    // (duplicate activity rows, repeated role updates) with nothing logged.
    if (error) {
      this.logger.error('Failed to update notification_log status', error);
    }
  }

  // Used for RM reminder rate-limiting: has a reminder been sent in the last
  // `hours` hours for this recipient email + email type?
  async wasSentRecently(
    recipientEmail: string,
    emailType: NotificationEmailType,
    hours: number,
    accountOwnerId?: string,
  ): Promise<boolean> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    let query = this.supabase
      .getClient()
      .from('notification_log')
      .select('id')
      .eq('recipient_email', recipientEmail.toLowerCase())
      .eq('email_type', emailType)
      .gte('sent_at', since);

    // Without this the window is global per email address, so one person acting
    // as Release Manager for two owners blocks the second owner's reminder for
    // the full window. Callers pass the owner whose reminder this is.
    if (accountOwnerId) {
      query = query.eq('metadata->>account_owner_id', accountOwnerId);
    }

    const { data, error } = await query.limit(1).maybeSingle();

    if (error) {
      this.logger.error('Failed to check notification_log rate limit', error);
      return false;
    }
    return !!data;
  }
}
