import { randomUUID } from 'crypto';
import sanitizeHtml from 'sanitize-html';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { EmailService } from '../shared/email/email.service.js';
import { SmsService } from '../shared/sms/sms.service.js';
import { NotificationLogService } from '../shared/notification-log/notification-log.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { GuardiansService } from '../guardians/guardians.service.js';
import { PdfService } from '../memoir/pdf.service.js';
import { InitiateReleaseDto } from './dto/initiate-release.dto.js';
import { CancelReleaseDto } from './dto/cancel-release.dto.js';
import { GuardianRequestDto } from './dto/guardian-request.dto.js';
import { addBusinessDays } from './rm-portal.util.js';

const WAITING_PERIOD_BUSINESS_DAYS = 5;

@Injectable()
export class ReleasePlanService {
  private readonly logger = new Logger(ReleasePlanService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    private readonly notificationLog: NotificationLogService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
    private readonly guardiansService: GuardiansService,
    private readonly pdfService: PdfService,
    private readonly config: ConfigService,
  ) {}

  private get frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL') ?? 'https://app.jointether.com';
  }

  private async getOwner(accountOwnerId: string) {
    const { data } = await this.supabase
      .getClient()
      .from('users')
      .select('id, full_name, email')
      .eq('id', accountOwnerId)
      .single();
    return data;
  }

  private async getRmRecord(accountOwnerId: string, rmUserId?: string) {
    const query = this.supabase
      .getClient()
      .from('release_managers')
      .select('id, name, email, rm_user_id')
      .eq('user_id', accountOwnerId)
      .not('status', 'in', '("revoked","declined")');

    const { data } = rmUserId
      ? await query.eq('rm_user_id', rmUserId).maybeSingle()
      : await query.maybeSingle();
    return data;
  }

  private async getLatestPlan(accountOwnerId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('release_plans')
      .select('*')
      .eq('user_id', accountOwnerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException('Failed to fetch release plan.');
    }
    return data;
  }

  // GET /rm/release-plan
  async getReleasePlan(accountOwnerId: string) {
    const owner = await this.getOwner(accountOwnerId);
    if (!owner) throw new NotFoundException('Account owner not found');

    const plan = await this.getLatestPlan(accountOwnerId);

    if (!plan || plan.status === 'cancelled') {
      const guardians = await this.guardiansService.findActiveByOwner(accountOwnerId);
      return {
        status: 'none',
        can_initiate: true,
        has_guardians: guardians.length > 0,
        guardian_count: guardians.length,
        account_owner_name: owner.full_name,
      };
    }

    const currentStep = await this.determineCurrentStep(plan);

    const base: Record<string, unknown> = {
      id: plan.id,
      plan_id: plan.plan_id,
      status: plan.status,
      current_step: currentStep,
      initiator_role: plan.initiator_role,
      reason: plan.reason,
      explanation: plan.explanation,
      initiated_at: plan.initiated_at,
      delivery_scheduled_at: plan.delivery_scheduled_at,
      delivered_at: plan.delivered_at,
      cancelled_at: plan.cancelled_at,
      account_owner_name: owner.full_name,
      step_2_notifications: null,
      step_3_waiting: null,
      step_4_delivery: null,
      step_5_complete: null,
    };

    if (currentStep === 2) {
      base.step_2_notifications = await this.buildStep2(plan);
    } else if (currentStep === 3) {
      base.step_3_waiting = await this.buildStep3(plan);
    } else if (currentStep === 4) {
      base.step_4_delivery = await this.buildStep4(plan);
    } else if (currentStep === 5) {
      base.step_4_delivery = await this.buildStep4(plan);
      base.step_5_complete = await this.buildStep5(accountOwnerId, plan);
    }

    return base;
  }

  private async determineCurrentStep(plan: any): Promise<number> {
    if (plan.status === 'delivered' || plan.delivered_at) {
      const { data: deliveryRows } = await this.supabase
        .getClient()
        .from('recipient_delivery_status')
        .select('portal_first_accessed_at')
        .eq('release_plan_id', plan.id);

      const allAccessed =
        (deliveryRows ?? []).length > 0 &&
        (deliveryRows ?? []).every((r) => !!r.portal_first_accessed_at);
      return allAccessed ? 5 : 4;
    }

    const { count: pendingNotifications } = await this.supabase
      .getClient()
      .from('notification_log')
      .select('id', { count: 'exact', head: true })
      .contains('metadata', { release_plan_id: plan.id })
      .eq('status', 'sending');

    if ((pendingNotifications ?? 0) > 0) return 2;

    // Step 3 is terminal until the RM manually advances, both during the
    // waiting period and after it elapses. There was previously a
    // `now < scheduledAt` branch here, but both sides returned 3 — the schedule
    // deliberately doesn't auto-advance, so the comparison was inert.
    return 3;
  }

  private async buildStep2(plan: any) {
    const { data: logs } = await this.supabase
      .getClient()
      .from('notification_log')
      .select('recipient_email, status, sent_at, metadata')
      .contains('metadata', { release_plan_id: plan.id });

    const parties = (logs ?? []).map((l) => {
      const metadata = (l.metadata ?? {}) as Record<string, unknown>;
      return {
        name: (metadata.name as string) ?? l.recipient_email,
        role: (metadata.party_role as string) ?? 'recipient',
        channel: (metadata.channel as string) ?? 'email',
        status: l.status,
        sent_at: l.sent_at ?? null,
      };
    });

    return {
      all_sent: parties.length > 0 && parties.every((p) => p.status !== 'sending'),
      parties,
    };
  }

  private async buildStep3(plan: any) {
    const initiatedAt = new Date(plan.initiated_at).getTime();
    const scheduledAt = new Date(plan.delivery_scheduled_at).getTime();
    const now = Date.now();
    const daysTotal = WAITING_PERIOD_BUSINESS_DAYS;

    // Either timestamp being null/malformed yields NaN, which would silently
    // collapse days_elapsed to 0 and pin is_complete/can_continue to false
    // forever. Return a neutral payload instead of nonsense.
    if (Number.isNaN(initiatedAt) || Number.isNaN(scheduledAt)) {
      return {
        window_opened: plan.initiated_at ?? null,
        delivery_scheduled: plan.delivery_scheduled_at ?? null,
        days_elapsed: 0,
        days_total: daysTotal,
        cancellations_received: 0,
        is_complete: false,
        can_continue: false,
      };
    }

    const elapsedMs = Math.min(now, scheduledAt) - initiatedAt;
    const totalMs = scheduledAt - initiatedAt;
    const daysElapsed = totalMs > 0 ? Math.round((elapsedMs / totalMs) * daysTotal) : 0;

    const { count: cancellations } = await this.supabase
      .getClient()
      .from('release_plan_activity_log')
      .select('id', { count: 'exact', head: true })
      .eq('release_plan_id', plan.id)
      .eq('event_type', 'release_cancelled');

    return {
      window_opened: plan.initiated_at,
      delivery_scheduled: plan.delivery_scheduled_at,
      days_elapsed: Math.max(0, Math.min(daysTotal, daysElapsed)),
      days_total: daysTotal,
      cancellations_received: cancellations ?? 0,
      is_complete: now >= scheduledAt,
      can_continue: now >= scheduledAt && (cancellations ?? 0) === 0,
    };
  }

  private async buildStep4(plan: any) {
    const { data: recipients } = await this.supabase
      .getClient()
      .from('recipient_delivery_status')
      .select('recipient_id, portal_status:email_status, portal_first_accessed_at, recipients(name)')
      .eq('release_plan_id', plan.id);

    const rows = (recipients ?? []).map((r: any) => ({
      id: r.recipient_id,
      name: r.recipients?.name ?? 'Recipient',
      portal_status: r.portal_first_accessed_at ? 'accessed' : 'delivered',
      portal_first_accessed_at: r.portal_first_accessed_at ?? null,
    }));

    const accessedCount = rows.filter((r) => r.portal_status === 'accessed').length;

    return {
      delivered_at: plan.delivered_at,
      recipients: rows,
      all_accessed: rows.length > 0 && accessedCount === rows.length,
      accessed_count: accessedCount,
      total_recipients: rows.length,
    };
  }

  private async buildStep5(accountOwnerId: string, plan: any) {
    const { data: assignments } = await this.supabase
      .getClient()
      .from('content_assignments')
      .select('content_type, content_id')
      .eq('user_id', accountOwnerId);

    const contentSummary = { messages: 0, photos: 0, documents: 0, memoir_chapters: 0 };
    const seen = new Set<string>();
    const typeKey: Record<string, keyof typeof contentSummary> = {
      message: 'messages',
      photo: 'photos',
      document: 'documents',
      chapter: 'memoir_chapters',
    };
    for (const a of assignments ?? []) {
      const key = typeKey[a.content_type];
      if (!key) continue;
      const dedupeKey = `${a.content_type}:${a.content_id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      contentSummary[key] += 1;
    }

    const { data: events } = await this.supabase
      .getClient()
      .from('release_plan_activity_log')
      .select('event_type, event_label, created_at')
      .eq('release_plan_id', plan.id)
      .order('created_at', { ascending: true });

    return {
      delivered_at: plan.delivered_at,
      content_summary: contentSummary,
      timeline: (events ?? []).map((e) => ({
        event: e.event_label,
        date: e.created_at,
      })),
    };
  }

  // POST /rm/release-plan/initiate
  async initiateRelease(
    accountOwnerId: string,
    rmUserId: string,
    dto: InitiateReleaseDto,
  ) {
    if (dto.confirmation_checked !== true) {
      throw new BadRequestException('confirmation_checked must be true');
    }

    const owner = await this.getOwner(accountOwnerId);
    if (!owner) throw new NotFoundException('Account owner not found');

    const { data: activePlans } = await this.supabase
      .getClient()
      .from('release_plans')
      .select('id')
      .eq('user_id', accountOwnerId)
      .in('status', ['active', 'paused']);

    if ((activePlans?.length ?? 0) > 0) {
      throw new ConflictException('An active release plan already exists for this account.');
    }

    const rm = await this.getRmRecord(accountOwnerId, rmUserId);

    // release_plans carries a `valid_initiator` check constraint: when
    // initiator_role is 'release_manager', initiator_rm_id must be non-null
    // (and likewise initiator_guardian_id for 'guardian'). Passing
    // `rm?.id ?? null` therefore fails the insert with an opaque 500 whenever
    // the release_managers row can't be resolved — e.g. an RM who accepted
    // their membership but whose rm_user_id was never linked. Fail fast with a
    // message that says what's actually wrong.
    if (!rm) {
      throw new NotFoundException(
        'No active Release Manager record is linked to your account for this owner. ' +
          'Re-accept the invitation or contact support before initiating a release.',
      );
    }

    const initiatedAt = new Date();
    const deliveryScheduledAt = addBusinessDays(initiatedAt, WAITING_PERIOD_BUSINESS_DAYS);
    const idempotencyKey = randomUUID();
    const cancelToken = randomUUID();

    const { data: plan, error } = await this.supabase
      .getClient()
      .from('release_plans')
      .insert({
        user_id: accountOwnerId,
        initiator_role: 'release_manager',
        initiator_rm_id: rm.id,
        reason: dto.reason,
        explanation: dto.explanation,
        confirmation_checked: true,
        status: 'active',
        initiated_at: initiatedAt.toISOString(),
        delivery_scheduled_at: deliveryScheduledAt.toISOString(),
        idempotency_key: idempotencyKey,
        cancel_token: cancelToken,
      })
      .select('id, plan_id, status, initiated_at, delivery_scheduled_at')
      .single();

    if (error || !plan) {
      throw new InternalServerErrorException('Failed to initiate release plan.');
    }

    const { data: recipients } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id, name, email, phone')
      .eq('user_id', accountOwnerId);

    if (recipients?.length) {
      await this.supabase
        .getClient()
        .from('recipient_delivery_status')
        .insert(
          recipients.map((r) => ({
            release_plan_id: plan.id,
            recipient_id: r.id,
            email_status: 'pending',
          })),
        );
    }

    await this.logReleaseEvent(plan.id, 'release_initiated', 'Release initiated by Release Manager', 'release_manager', accountOwnerId);

    // Fire-and-forget notification sending; the frontend polls
    // GET /rm/release-plan/notification-status while this runs.
    this.sendInitiationNotifications(plan.id, accountOwnerId, owner, rm, dto, deliveryScheduledAt, cancelToken, recipients ?? []).catch(
      (err) => this.logger.error('Failed to send initiation notifications', err),
    );

    this.activityService.log(
      accountOwnerId,
      'release_initiated',
      `Release Plan ${plan.plan_id} initiated`,
      { planId: plan.id, reason: dto.reason },
    );
    this.posthog.capture(accountOwnerId, 'server_release_initiated', {
      planId: plan.id,
      reason: dto.reason,
      recipientCount: recipients?.length ?? 0,
    });

    return {
      id: plan.id,
      plan_id: plan.plan_id,
      status: plan.status,
      initiated_at: plan.initiated_at,
      delivery_scheduled_at: plan.delivery_scheduled_at,
    };
  }

  private async sendInitiationNotifications(
    planId: string,
    accountOwnerId: string,
    owner: { full_name: string; email: string },
    rm: { name: string; email: string } | null,
    dto: InitiateReleaseDto,
    deliveryScheduledAt: Date,
    cancelToken: string,
    recipients: Array<{ id: string; name: string; email: string; phone: string | null }>,
  ) {
    await this.logReleaseEvent(planId, 'notifications_sending', 'Sending notifications to all parties', 'system', accountOwnerId);

    const deliveryDate = deliveryScheduledAt.toDateString();
    const cancelUrl = `${this.frontendUrl}/release/cancel/${cancelToken}`;

    const ownerMessageId = await this.emailService
      .sendReleaseNotificationToOwner({
        to: owner.email,
        ownerName: owner.full_name,
        rmName: rm?.name ?? 'Your Release Manager',
        reason: dto.reason,
        deliveryDate,
        cancelUrl,
        planId,
      })
      .catch((err) => {
        this.logger.error('Failed to email account owner', err);
        return null;
      });

    await this.notificationLog.logEmailSent({
      userId: accountOwnerId,
      recipientEmail: owner.email,
      emailType: 'recipient_notification',
      resendMessageId: ownerMessageId,
      metadata: {
        account_owner_id: accountOwnerId,
        release_plan_id: planId,
        name: owner.full_name,
        party_role: 'account_owner',
        channel: 'email',
      },
    });

    for (const recipient of recipients) {
      const messageId = await this.emailService
        .sendReleaseNotificationToRecipient({
          to: recipient.email,
          recipientName: recipient.name,
          ownerName: owner.full_name,
          deliveryDate,
        })
        .catch((err) => {
          this.logger.error(`Failed to email recipient ${recipient.id}`, err);
          return null;
        });

      await this.notificationLog.logEmailSent({
        recipientEmail: recipient.email,
        emailType: 'recipient_notification',
        resendMessageId: messageId,
        metadata: {
          account_owner_id: accountOwnerId,
          release_plan_id: planId,
          recipient_id: recipient.id,
          name: recipient.name,
          party_role: 'recipient',
          channel: recipient.phone ? 'email+sms' : 'email',
        },
      });

      if (recipient.phone) {
        await this.smsService.send(
          recipient.phone,
          `${owner.full_name} has prepared content for you on Tether. You'll receive a link on ${deliveryDate}.`,
        );
      }
    }

    await this.logReleaseEvent(planId, 'notifications_sent', 'All parties notified', 'system', accountOwnerId);
    await this.logReleaseEvent(planId, 'waiting_period_started', '5-day waiting period started', 'system', accountOwnerId);
  }

  // POST /rm/release-plan/cancel
  async cancelRelease(accountOwnerId: string, dto: CancelReleaseDto) {
    const plan = await this.getLatestPlan(accountOwnerId);
    if (!plan || plan.status !== 'active') {
      throw new NotFoundException('No active release plan to cancel.');
    }

    await this.cancelPlan(plan, dto.reason, 'release_manager');

    return { id: plan.id, status: 'cancelled', cancelled_at: new Date().toISOString() };
  }

  // GET /release/cancel/:token — public, no auth
  // Read-only lookup for the public cancel-confirmation page (GET) — never
  // mutates state. The actual cancellation only happens via cancelByToken,
  // triggered by an explicit confirmation action (POST).
  async peekCancelStatus(token: string) {
    const { data: plan, error } = await this.supabase
      .getClient()
      .from('release_plans')
      .select('status')
      .eq('cancel_token', token)
      .maybeSingle();

    if (error || !plan) {
      throw new NotFoundException('Invalid or expired cancel link.');
    }

    return {
      status: plan.status,
      canCancel: plan.status === 'active',
    };
  }

  async cancelByToken(token: string) {
    const { data: plan, error } = await this.supabase
      .getClient()
      .from('release_plans')
      .select('*')
      .eq('cancel_token', token)
      .maybeSingle();

    if (error || !plan) {
      throw new NotFoundException('Invalid or expired cancel link.');
    }
    if (plan.status !== 'active') {
      return { status: plan.status, message: 'This release plan is no longer active.' };
    }

    await this.cancelPlan(plan, 'Cancelled by account owner via email link.', 'account_owner');

    return { status: 'cancelled', message: 'The release has been cancelled.' };
  }

  private async cancelPlan(plan: any, reason: string, cancelledBy: 'release_manager' | 'account_owner') {
    // Conditional on status = 'active', mirroring continueDelivery: both
    // cancelRelease and cancelByToken read the plan and then update, so two
    // concurrent cancels (or one racing continueDelivery) would otherwise both
    // proceed and double-send cancellation emails plus duplicate the log row.
    const { data: cancelledRows, error } = await this.supabase
      .getClient()
      .from('release_plans')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancelled_by: cancelledBy,
        updated_at: new Date().toISOString(),
      })
      .eq('id', plan.id)
      .eq('status', 'active')
      .select('id');

    if (error) {
      throw new InternalServerErrorException('Failed to cancel release plan.');
    }

    // Another caller won the race and already cancelled — don't fire the side
    // effects a second time.
    if (!cancelledRows?.length) return;

    const audited = await this.logReleaseEvent(
      plan.id,
      'release_cancelled',
      `Release cancelled by ${cancelledBy === 'release_manager' ? 'Release Manager' : 'account owner'}`,
      cancelledBy,
      plan.user_id,
    );

    // Deliberately not thrown. The cancellation itself is already committed —
    // release_plans.status is the authority that stops delivery, and the
    // activity_log entry below is a second durable record. Failing the request
    // here would report a cancellation that actually happened as an error, which
    // is the more dangerous outcome. Escalated instead, because the RM's
    // cancellations_received count is derived from the row we just failed to
    // write and will under-report until it's reconciled.
    if (!audited) {
      this.logger.error(
        `Release ${plan.id} was cancelled but its release_plan_activity_log entry could not be written. ` +
          `Delivery is still correctly blocked by release_plans.status='cancelled'; ` +
          `cancellations_received will under-report for this plan until the row is backfilled.`,
      );
    }

    this.notifyCancellation(plan, reason).catch((err) =>
      this.logger.error('Failed to send cancellation notifications', err),
    );

    this.activityService.log(plan.user_id, 'release_cancelled', 'Release plan cancelled', {
      planId: plan.id,
      cancelledBy,
      reason,
    });
    this.posthog.capture(plan.user_id, 'server_release_cancelled', {
      planId: plan.id,
      cancelledBy,
      daysSinceInitiation: this.daysSince(plan.initiated_at),
    });
  }

  private async notifyCancellation(plan: any, reason: string) {
    const owner = await this.getOwner(plan.user_id);
    if (!owner) return;

    const { data: recipients } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id, name, email')
      .eq('user_id', plan.user_id);

    const parties = [
      { id: null as string | null, name: owner.full_name, email: owner.email },
      ...((recipients ?? []) as Array<{ id: string; name: string; email: string }>),
    ];

    for (const party of parties) {
      const messageId = await this.emailService
        .sendReleaseCancelledNotification({
          to: party.email,
          name: party.name,
          ownerName: owner.full_name,
          reason,
        })
        .catch(() => null);

      await this.notificationLog.logEmailSent({
        recipientEmail: party.email,
        emailType: 'recipient_notification',
        resendMessageId: messageId,
        metadata: {
          account_owner_id: plan.user_id,
          release_plan_id: plan.id,
          name: party.name,
          ...(party.id ? { recipient_id: party.id } : { party_role: 'account_owner' }),
        },
      });
    }
  }

  // GET /rm/release-plan/notification-status
  async getNotificationStatus(accountOwnerId: string) {
    const plan = await this.getLatestPlan(accountOwnerId);
    if (!plan) throw new NotFoundException('No release plan found.');

    const step2 = await this.buildStep2(plan);
    return { release_plan_id: plan.id, ...step2 };
  }

  // POST /rm/release-plan/continue-delivery
  async continueDelivery(accountOwnerId: string) {
    const plan = await this.getLatestPlan(accountOwnerId);
    if (!plan || plan.status !== 'active') {
      throw new NotFoundException('No active release plan.');
    }
    if (plan.delivered_at) {
      throw new ConflictException('This release plan has already been delivered.');
    }
    if (new Date(plan.delivery_scheduled_at).getTime() > Date.now()) {
      throw new BadRequestException('The waiting period has not yet elapsed.');
    }

    const { count: cancellations } = await this.supabase
      .getClient()
      .from('release_plan_activity_log')
      .select('id', { count: 'exact', head: true })
      .eq('release_plan_id', plan.id)
      .eq('event_type', 'release_cancelled');

    if ((cancellations ?? 0) > 0) {
      throw new ConflictException('This release plan was cancelled.');
    }

    const deliveredAt = new Date().toISOString();

    // Conditioned on delivered_at still being null so two concurrent calls
    // (e.g. a retried request) can't both "win" and send delivery emails
    // twice — only the call that actually flips the row proceeds.
    const { data: updatedRows, error } = await this.supabase
      .getClient()
      .from('release_plans')
      .update({ delivered_at: deliveredAt, updated_at: deliveredAt })
      .eq('id', plan.id)
      .is('delivered_at', null)
      .select('id');

    if (error) {
      throw new InternalServerErrorException('Failed to advance to delivery.');
    }
    if (!updatedRows || updatedRows.length === 0) {
      throw new ConflictException('This release plan has already been delivered.');
    }

    await this.logReleaseEvent(plan.id, 'waiting_period_complete', 'Waiting period complete — no cancellation received', 'system', accountOwnerId);

    const owner = await this.getOwner(accountOwnerId);
    const { data: deliveryRows } = await this.supabase
      .getClient()
      .from('recipient_delivery_status')
      .select('id, recipient_id, recipients(name, email, phone)')
      .eq('release_plan_id', plan.id);

    let notified = 0;
    for (const row of deliveryRows ?? []) {
      const recipient = (row as any).recipients;
      if (!recipient) continue;

      const portalUrl = `${this.frontendUrl}/portal/${plan.id}/${row.recipient_id}`;
      const messageId = await this.emailService
        .sendDeliveryEmail({
          to: recipient.email,
          recipientName: recipient.name,
          ownerName: owner?.full_name ?? 'Your loved one',
          portalUrl,
        })
        .catch((err) => {
          this.logger.error(`Failed to send delivery email to recipient ${row.recipient_id}`, err);
          return null;
        });

      await this.notificationLog.logEmailSent({
        recipientEmail: recipient.email,
        emailType: 'recipient_notification',
        resendMessageId: messageId,
        metadata: {
          account_owner_id: accountOwnerId,
          release_plan_id: plan.id,
          name: recipient.name,
          recipient_id: row.recipient_id,
        },
      });

      if (recipient.phone) {
        await this.smsService.send(
          recipient.phone,
          `${owner?.full_name ?? 'Your loved one'}'s legacy is ready for you: ${portalUrl}`,
        );
      }

      await this.supabase
        .getClient()
        .from('recipient_delivery_status')
        .update({
          email_status: messageId ? 'sent' : 'failed',
          portal_unlocked_at: deliveredAt,
          updated_at: deliveredAt,
        })
        .eq('id', row.id);

      await this.logReleaseEvent(
        plan.id,
        'delivery_email_sent',
        `Delivery email sent to ${recipient.name}`,
        'system',
        // Inside the per-recipient loop — without this the owner lookup would
        // run once per recipient.
        plan.user_id,
      );
      notified++;
    }

    await this.logReleaseEvent(plan.id, 'content_delivered', 'Content delivered to all recipients', 'system', accountOwnerId);

    this.posthog.capture(accountOwnerId, 'server_release_delivered', {
      planId: plan.id,
      recipientCount: notified,
      daysSinceInitiation: this.daysSince(plan.initiated_at),
    });

    return { status: 'delivered', delivered_at: deliveredAt, recipients_notified: notified };
  }

  // GET /rm/release-plan/delivery-status
  async getDeliveryStatus(accountOwnerId: string) {
    const plan = await this.getLatestPlan(accountOwnerId);
    if (!plan) throw new NotFoundException('No release plan found.');

    const { data: rows, error } = await this.supabase
      .getClient()
      .from('recipient_delivery_status')
      .select(
        'recipient_id, email_status, email_bounced_at, portal_unlocked_at, portal_first_accessed_at, retry_email, recipients(name, email)',
      )
      .eq('release_plan_id', plan.id);

    if (error) {
      throw new InternalServerErrorException('Failed to fetch delivery status.');
    }

    const retryDeadline = plan.delivery_scheduled_at
      ? addBusinessDays(new Date(plan.delivery_scheduled_at), 5).toISOString()
      : null;

    const recipients = (rows ?? []).map((r: any) => {
      const portalStatus = r.portal_first_accessed_at
        ? 'accessed'
        : r.email_status === 'bounced'
          ? 'bounced'
          : 'delivered';

      return {
        id: r.recipient_id,
        name: r.recipients?.name ?? 'Recipient',
        email: r.recipients?.email ?? null,
        email_status: r.email_status,
        portal_unlocked_at: r.portal_unlocked_at ?? null,
        portal_first_accessed_at: r.portal_first_accessed_at ?? null,
        portal_status: portalStatus,
        ...(r.email_status === 'bounced'
          ? {
              email_bounced_at: r.email_bounced_at ?? null,
              retry_email: r.retry_email ?? null,
              retry_deadline: retryDeadline,
            }
          : {}),
      };
    });

    const accessedCount = recipients.filter((r) => r.portal_status === 'accessed').length;
    const bouncedCount = recipients.filter((r) => r.portal_status === 'bounced').length;

    return {
      release_plan_id: plan.id,
      delivered_at: plan.delivered_at,
      recipients,
      all_accessed: recipients.length > 0 && accessedCount === recipients.length,
      accessed_count: accessedCount,
      bounced_count: bouncedCount,
      total: recipients.length,
    };
  }

  // Called by the recipient portal when they first open their link.
  async markPortalAccessed(releasePlanId: string, recipientId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('recipient_delivery_status')
      .update({ portal_first_accessed_at: new Date().toISOString() })
      .eq('release_plan_id', releasePlanId)
      .eq('recipient_id', recipientId)
      .is('portal_first_accessed_at', null)
      .select('id')
      .maybeSingle();

    if (data) {
      await this.logReleaseEvent(releasePlanId, 'portal_accessed', 'Recipient accessed their portal', 'recipient');
      const { data: plan } = await this.supabase
        .getClient()
        .from('release_plans')
        .select('user_id')
        .eq('id', releasePlanId)
        .single();
      if (plan) {
        this.posthog.capture(plan.user_id, 'server_portal_accessed', {
          planId: releasePlanId,
          recipientId,
        });
      }
    }
    if (error) {
      this.logger.error('Failed to mark portal accessed', error);
    }
  }

  // GET /rm/release-plan/activity-log
  async getActivityLog(accountOwnerId: string) {
    const plan = await this.getLatestPlan(accountOwnerId);
    if (!plan) throw new NotFoundException('No release plan found.');

    const { data, error } = await this.supabase
      .getClient()
      .from('release_plan_activity_log')
      .select('id, event_type, event_label, actor_role, created_at')
      .eq('release_plan_id', plan.id)
      .order('created_at', { ascending: true });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch activity log.');
    }

    const rm = await this.getRmRecord(accountOwnerId);

    return {
      release_plan_id: plan.id,
      plan_id: plan.plan_id,
      events: (data ?? []).map((e) => ({
        id: e.id,
        event_type: e.event_type,
        event_label: e.event_label,
        actor_name: e.actor_role === 'release_manager' ? rm?.name ?? null : null,
        actor_role: e.actor_role,
        created_at: e.created_at,
      })),
    };
  }

  // GET /rm/release-plan/activity-report
  async generateActivityReportPdf(accountOwnerId: string): Promise<{ buffer: Buffer; filename: string }> {
    const plan = await this.getLatestPlan(accountOwnerId);
    if (!plan) throw new NotFoundException('No release plan found.');

    const owner = await this.getOwner(accountOwnerId);
    const activityLog = await this.getActivityLog(accountOwnerId);
    const deliveryStatus = await this.getDeliveryStatus(accountOwnerId).catch(() => null);
    const contentSummary = await this.buildStep5(accountOwnerId, plan);

    const html = this.buildActivityReportHtml(plan, owner, activityLog, deliveryStatus, contentSummary);
    const buffer = await this.pdfService.generatePdfFromHtml(html);

    this.activityService.log(accountOwnerId, 'activity_report_downloaded', 'Activity report downloaded', {
      planId: plan.id,
    });

    return { buffer, filename: `Release-Plan-${plan.plan_id}-Report.pdf` };
  }

  private buildActivityReportHtml(
    plan: any,
    owner: any,
    activityLog: { events: Array<{ event_label: string; created_at: string }> },
    deliveryStatus: { recipients: Array<{ name: string; portal_status: string }> } | null,
    contentSummary: { content_summary: Record<string, number> },
  ): string {
    const esc = (v: unknown) => sanitizeHtml(String(v ?? ''), { allowedTags: [] });

    const events = activityLog.events
      .map((e) => `<tr><td>${esc(e.created_at)}</td><td>${esc(e.event_label)}</td></tr>`)
      .join('');
    const recipientRows = (deliveryStatus?.recipients ?? [])
      .map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.portal_status)}</td></tr>`)
      .join('');
    const summaryRows = Object.entries(contentSummary.content_summary)
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
      .join('');

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:sans-serif;color:#222}
h1{font-size:1.6em}
table{width:100%;border-collapse:collapse;margin-bottom:2em}
td{border-bottom:1px solid #eee;padding:6px 8px}
</style></head><body>
<h1>Release Plan ${esc(plan.plan_id)}</h1>
<p><strong>Account owner:</strong> ${esc(owner?.full_name)}</p>
<p><strong>Initiated:</strong> ${esc(plan.initiated_at)}</p>
<p><strong>Delivery scheduled:</strong> ${esc(plan.delivery_scheduled_at)}</p>
<p><strong>Reason:</strong> ${esc(plan.reason)}</p>
<h2>Content Summary</h2>
<table>${summaryRows}</table>
<h2>Recipient Delivery Status</h2>
<table>${recipientRows}</table>
<h2>Activity Timeline</h2>
<table>${events}</table>
</body></html>`;
  }

  // POST /rm/release-plan/guardian-request
  async requestGuardianEscalation(
    accountOwnerId: string,
    rmUserId: string,
    dto: GuardianRequestDto,
  ) {
    const owner = await this.getOwner(accountOwnerId);
    if (!owner) throw new NotFoundException('Account owner not found');

    const rm = await this.getRmRecord(accountOwnerId, rmUserId);
    if (!rm) throw new NotFoundException('Release Manager record not found for this context.');

    const guardians = await this.guardiansService.findActiveByOwner(accountOwnerId);
    if (guardians.length === 0) {
      throw new NotFoundException('No Guardians designated for this account.');
    }

    const guardian = guardians[0]; // lowest priority_order first (findActiveByOwner orders ascending)

    const { data: escalation, error } = await this.supabase
      .getClient()
      .from('guardian_escalations')
      .insert({
        account_id: accountOwnerId,
        release_manager_id: rm.id,
        guardian_id: guardian.id,
        message: dto.explanation,
        status: 'pending',
      })
      .select('id')
      .single();

    if (error || !escalation) {
      throw new InternalServerErrorException('Failed to request guardian escalation.');
    }

    // Resolved from account_memberships, not guardians.invitation_token —
    // acceptInvitation matches the membership token, and interpolating a
    // consumed/cleared guardians token would produce `/accept/null`. Falls back
    // to the portal when there's no live invitation left to accept.
    const { data: guardianMembership } = await this.supabase
      .getClient()
      .from('account_memberships')
      .select('invitation_token')
      .eq('account_owner_id', accountOwnerId)
      .eq('role', 'guardian')
      .eq('invite_email', guardian.email.toLowerCase())
      .not('status', 'in', '("revoked","declined")')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const acceptUrl = guardianMembership?.invitation_token
      ? `${this.frontendUrl}/invitations/accept/${guardianMembership.invitation_token}`
      : `${this.frontendUrl}/rm/release-plan`;

    const messageId = await this.emailService
      .sendGuardianEscalation({
        to: guardian.email,
        guardianName: guardian.name,
        ownerName: owner.full_name,
        rmName: rm.name,
        explanation: dto.explanation,
        acceptUrl,
      })
      .catch((err) => {
        this.logger.error('Failed to send guardian escalation email', err);
        return null;
      });

    await this.notificationLog.logEmailSent({
      recipientEmail: guardian.email,
      emailType: 'guardian_invitation',
      resendMessageId: messageId,
      metadata: { account_owner_id: accountOwnerId, guardian_id: guardian.id, escalation_id: escalation.id },
    });

    const plan = await this.getLatestPlan(accountOwnerId);
    if (plan) {
      await this.logReleaseEvent(
        plan.id,
        'guardian_escalation',
        `Guardian escalation requested by ${rm.name}`,
        'release_manager',
        accountOwnerId,
      );
    }

    this.activityService.log(accountOwnerId, 'guardian_escalation_requested', `Guardian escalation requested — ${guardian.name}`, {
      guardianId: guardian.id,
      escalationId: escalation.id,
    });
    this.posthog.capture(accountOwnerId, 'server_guardian_escalation', {
      planId: plan?.id ?? null,
      guardianId: guardian.id,
      guardianOrder: guardian.priority_order,
    });

    return {
      id: escalation.id,
      guardian_notified: guardian.name,
      guardian_order: guardian.priority_order,
      // Email only — this path sends no SMS (contrast continueDelivery, which
      // does call smsService). Don't promise a channel we didn't use.
      message: `Guardian ${guardian.priority_order} has been notified via email.`,
    };
  }

  /** Returns whether the audit row was written. Callers on release-critical
   *  paths check this; the rest treat logging as best-effort. */
  private async logReleaseEvent(
    releasePlanId: string,
    eventType: string,
    eventLabel: string,
    actorRole: string,
    userId?: string,
  ): Promise<boolean> {
    // release_plan_activity_log.user_id is NOT NULL and identifies the account
    // owner the plan belongs to — actor_role separately records who acted. It
    // was omitted entirely before, so every insert failed the not-null check;
    // because the result was never inspected, the failure was silent and the
    // activity log stayed permanently empty (taking the activity report PDF and
    // buildStep3's cancellation count with it).
    // Every caller that already has the owner passes it. The fallback exists for
    // markPortalAccessed, which is reached from the recipient portal and only
    // ever knows the plan id.
    let ownerId = userId;
    if (!ownerId) {
      const { data, error: lookupError } = await this.supabase
        .getClient()
        .from('release_plans')
        .select('user_id')
        .eq('id', releasePlanId)
        .maybeSingle();

      // Logged with the real cause: otherwise a failed lookup is
      // indistinguishable from "plan not found" in the generic message below.
      if (lookupError) {
        this.logger.error(
          `Failed to resolve owner for plan ${releasePlanId} while logging '${eventType}'`,
          lookupError,
        );
      }
      ownerId = (data as { user_id: string } | null)?.user_id;
    }

    if (!ownerId) {
      this.logger.error(
        `Cannot log release event '${eventType}': no owner resolved for plan ${releasePlanId}`,
      );
      return false;
    }

    // Retried once. This table is the audit trail for a legally sensitive
    // handover, and buildStep3 derives cancellations_received by counting
    // release_cancelled rows — a dropped insert under-reports a cancellation to
    // the Release Manager. One retry covers the transient connection blips that
    // account for most failures without turning a hard error into a stall.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { error } = await this.supabase
        .getClient()
        .from('release_plan_activity_log')
        .insert({
          release_plan_id: releasePlanId,
          user_id: ownerId,
          event_type: eventType,
          event_label: eventLabel,
          actor_role: actorRole,
        });

      if (!error) return true;

      if (attempt === 1) {
        this.logger.warn(
          `Retrying release event '${eventType}' for plan ${releasePlanId} after insert failure: ${error.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }

      this.logger.error(
        `Failed to log release event '${eventType}' for plan ${releasePlanId} after 2 attempts`,
        error,
      );
    }

    return false;
  }

  private daysSince(iso: string | null): number | null {
    if (!iso) return null;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return null;
    return Math.floor((Date.now() - then) / 86_400_000);
  }
}
