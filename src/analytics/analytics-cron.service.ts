import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';

const ONBOARDING_STEPS = [
  'finish_account',
  'add_release_manager',
  'add_recipients',
  'add_photos',
  'create_message',
] as const;

const ONBOARDING_ABANDON_DAYS = 7;
const MEMOIR_ABANDON_DAYS = 14;
const DAY_MS = 86_400_000;

type OnboardingState = Record<string, boolean | string | null>;

/**
 * Daily jobs that fire the tracking plan's time-based abandonment events. Each
 * job writes a marker on the row it fires for so it never double-fires.
 * Runs on a single instance (Railway) — no distributed locking needed.
 */
@Injectable()
export class AnalyticsCronService {
  private readonly logger = new Logger(AnalyticsCronService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly posthog: PostHogService,
  ) {}

  // `onboarding_abandoned` — signup older than 7 days, onboarding never
  // completed, not already flagged.
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async onboardingAbandoned(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - ONBOARDING_ABANDON_DAYS * DAY_MS).toISOString();
      const { data: users } = await this.supabase
        .getClient()
        .from('users')
        .select('id, created_at, onboarding')
        .lt('created_at', cutoff);

      for (const user of users ?? []) {
        const onboarding = ((user.onboarding as OnboardingState) ?? {}) as OnboardingState;
        if (typeof onboarding['completed_at'] === 'string') continue; // completed
        if (typeof onboarding['abandoned_at'] === 'string') continue; // already fired

        this.posthog.capture(user.id, 'onboarding_abandoned', {
          last_completed_step: this.lastCompletedStep(onboarding),
          days_since_signup: this.daysSince(user.created_at as string | null),
        });

        onboarding['abandoned_at'] = new Date().toISOString();
        await this.supabase
          .getClient()
          .from('users')
          .update({ onboarding, updated_at: new Date().toISOString() })
          .eq('id', user.id);
      }
    } catch (err) {
      this.logger.error(
        'onboarding_abandoned job failed',
        err instanceof Error ? err.stack : err,
      );
    }
  }

  // `memoir_abandoned` — at least one chapter, no chapter edited in 14 days,
  // not already flagged on the memoir row.
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async memoirAbandoned(): Promise<void> {
    try {
      const cutoffMs = Date.now() - MEMOIR_ABANDON_DAYS * DAY_MS;

      const { data: memoirs } = await this.supabase
        .getClient()
        .from('memoirs')
        .select('id, user_id, abandoned_at')
        .is('abandoned_at', null);

      for (const memoir of memoirs ?? []) {
        const { data: chapters } = await this.supabase
          .getClient()
          .from('chapters')
          .select('status, updated_at')
          .eq('user_id', memoir.user_id);

        const rows = chapters ?? [];
        if (rows.length === 0) continue; // no chapters — nothing to abandon

        const lastEdit = Math.max(
          ...rows.map((c) => new Date(c.updated_at as string).getTime() || 0),
        );
        if (lastEdit >= cutoffMs) continue; // still active

        const completed = rows.filter((c) => c.status === 'complete').length;

        this.posthog.capture(memoir.user_id, 'memoir_abandoned', {
          chapters_completed: completed,
          days_since_last_edit: Math.max(
            0,
            Math.floor((Date.now() - lastEdit) / DAY_MS),
          ),
        });

        await this.supabase
          .getClient()
          .from('memoirs')
          .update({ abandoned_at: new Date().toISOString() })
          .eq('id', memoir.id);
      }
    } catch (err) {
      this.logger.error(
        'memoir_abandoned job failed',
        err instanceof Error ? err.stack : err,
      );
    }
  }

  private lastCompletedStep(onboarding: OnboardingState): string | null {
    let last: string | null = null;
    for (const step of ONBOARDING_STEPS) {
      if (onboarding[step] === true) last = step;
    }
    return last;
  }

  private daysSince(iso: string | null): number | null {
    if (!iso) return null;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return null;
    return Math.max(0, Math.floor((Date.now() - then) / DAY_MS));
  }
}
