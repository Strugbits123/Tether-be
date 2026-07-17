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

        // Atomically claim the marker: sets only the abandoned_at JSON path and
        // only if the user still hasn't completed or been marked (guards against
        // a step completing between the read above and this write). Fire the
        // event only when the claim actually took a row, so it can't double-fire.
        const { data: claimed, error } = await this.supabase
          .getClient()
          .rpc('claim_onboarding_abandoned', { p_user_id: user.id });

        if (error) {
          this.logger.warn(
            `claim_onboarding_abandoned failed for ${user.id}: ${error.message}`,
          );
          continue;
        }
        const row = (claimed as { created_at: string; onboarding: OnboardingState }[] | null)?.[0];
        if (!row) continue; // someone else completed/claimed it first

        this.posthog.capture(user.id, 'onboarding_abandoned', {
          last_completed_step: this.lastCompletedStep(
            (row.onboarding ?? onboarding) as OnboardingState,
          ),
          days_since_signup: this.daysSince(row.created_at ?? null),
        });
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
      const cutoff = new Date(Date.now() - MEMOIR_ABANDON_DAYS * DAY_MS).toISOString();

      const { data: memoirs } = await this.supabase
        .getClient()
        .from('memoirs')
        .select('id, user_id')
        .is('abandoned_at', null);

      for (const memoir of memoirs ?? []) {
        // Claim + revalidate inactivity in one atomic statement: the RPC only
        // marks the memoir when it's still unmarked, has chapters, and NO
        // chapter has updated_at >= cutoff — so a chapter edited between listing
        // and claiming can't produce a false marker/event. It returns the event
        // props only when it actually claimed.
        const { data, error } = await this.supabase
          .getClient()
          .rpc('claim_memoir_abandoned', {
            p_memoir_id: memoir.id,
            p_user_id: memoir.user_id,
            p_cutoff: cutoff,
          });

        if (error) {
          this.logger.warn(
            `claim_memoir_abandoned failed for ${memoir.id}: ${error.message}`,
          );
          continue;
        }
        const claimed = (data as
          | { chapters_completed: number; days_since_last_edit: number }[]
          | null)?.[0];
        if (!claimed) continue; // not claimed (already marked, no chapters, or active)

        this.posthog.capture(memoir.user_id, 'memoir_abandoned', {
          chapters_completed: claimed.chapters_completed,
          days_since_last_edit: claimed.days_since_last_edit,
        });
      }
    } catch (err) {
      this.logger.error(
        'memoir_abandoned job failed',
        err instanceof Error ? err.stack : err,
      );
    }
  }

  // Drain the analytics outbox: publish durably-enqueued lifecycle events to
  // PostHog, using each row id as the event uuid so a re-send is de-duplicated.
  // Runs frequently so committed-but-unpublished events surface quickly.
  @Cron(CronExpression.EVERY_MINUTE)
  async drainAnalyticsOutbox(): Promise<void> {
    // If PostHog isn't configured, don't drain — leaving rows unpublished (and
    // a warning) is far safer than marking them published without delivery. In
    // dev this is expected; in prod a missing key is a loud, recoverable signal
    // (events stay queued until the key is restored).
    if (!this.posthog.isEnabled()) {
      this.logger.warn(
        'analytics_outbox not drained: PostHog is not configured (POSTHOG_API_KEY missing)',
      );
      return;
    }

    try {
      const { data: rows, error } = await this.supabase
        .getClient()
        .from('analytics_outbox')
        .select('id, distinct_id, event, properties, attempts')
        .is('published_at', null)
        .lt('attempts', 10)
        .order('created_at', { ascending: true })
        .limit(200);

      if (error) {
        this.logger.warn(`analytics_outbox read failed: ${error.message}`);
        return;
      }

      for (const row of rows ?? []) {
        // Bump attempts first so a repeatedly-failing row eventually stops being
        // retried (and can't wedge the drain).
        await this.supabase
          .getClient()
          .from('analytics_outbox')
          .update({ attempts: (row.attempts ?? 0) + 1 })
          .eq('id', row.id);

        try {
          // Awaited send — resolves only after PostHog receives the event, so we
          // never mark a row published before it's actually delivered. The row
          // id is the idempotency key, so a retry after a partial failure is
          // de-duplicated.
          await this.posthog.captureImmediate(
            row.distinct_id,
            row.event,
            (row.properties ?? {}) as Record<string, unknown>,
            row.id,
          );
        } catch (sendErr) {
          this.logger.warn(
            `analytics_outbox publish failed for ${row.id}: ${
              sendErr instanceof Error ? sendErr.message : sendErr
            }`,
          );
          continue; // leave unpublished for the next run to retry
        }

        await this.supabase
          .getClient()
          .from('analytics_outbox')
          .update({ published_at: new Date().toISOString() })
          .eq('id', row.id);
      }
    } catch (err) {
      this.logger.error(
        'drain_analytics_outbox job failed',
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
