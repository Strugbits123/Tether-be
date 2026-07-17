import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service.js';
import { PostHogService } from './posthog.service.js';

// The five onboarding steps, in order. `completed_at` is stamped once all five
// are true (see markOnboardingStep).
const ONBOARDING_STEPS = [
  'finish_account',
  'add_release_manager',
  'add_recipients',
  'add_photos',
  'create_message',
] as const;

type OnboardingState = Record<string, boolean | string | null>;

/**
 * Central home for cross-cutting analytics that need DB access:
 *   - identify enrichment (the full person-property set from the tracking plan)
 *   - onboarding-step completion, which is the single place that detects the
 *     "all steps complete" transition and fires `onboarding_completed` +
 *     `account_activated` exactly once.
 *
 * Lives in the global SharedModule so every feature module can inject it.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly posthog: PostHogService,
  ) {}

  /**
   * Recompute the tracking-plan person properties for a user and push them to
   * PostHog via identify. Safe to call after any state change that affects them
   * (signup, profile completion, login, recipient/RM/message creation).
   */
  async identifyUser(userId: string): Promise<void> {
    try {
      const props = await this.buildPersonProperties(userId);
      if (props) this.posthog.identify(userId, props);
    } catch (err) {
      this.logger.error(
        'Failed to enrich PostHog identify',
        err instanceof Error ? err.stack : err,
      );
    }
  }

  /**
   * Mark an onboarding step complete. Sets the flag, and when this call is the
   * one that completes the final step, stamps `completed_at` and fires
   * `onboarding_completed` and `account_activated` a single time. Replaces the
   * per-service markOnboarding* helpers so completion is detected no matter
   * which step finishes last.
   */
  async markOnboardingStep(userId: string, step: string): Promise<void> {
    // The flag set + all-complete decision happen atomically in a row-locked DB
    // function, so concurrent step completions can't clobber each other, miss
    // activation, or both emit the completion event. Events fire only from the
    // function's returned `just_completed` transition.
    const { data, error } = await this.supabase
      .getClient()
      .rpc('complete_onboarding_step', { p_user_id: userId, p_step: step });

    if (error) {
      this.logger.error(`complete_onboarding_step failed: ${error.message}`);
      return;
    }

    const result = (data as { just_completed: boolean }[] | null)?.[0];
    if (!result) return; // no such user

    // onboarding_completed / account_activated are enqueued in the outbox by
    // the RPC (same transaction) and published durably by the outbox drainer,
    // so they are NOT fired here.

    // Keep person properties fresh so activation_status / has_* flags reflect
    // the new step.
    await this.identifyUser(userId);
  }

  private async buildPersonProperties(
    userId: string,
  ): Promise<Record<string, any> | null> {
    const client = this.supabase.getClient();

    const { data: user } = await client
      .from('users')
      .select('email, first_name, account_status, onboarding, created_at')
      .eq('id', userId)
      .single();

    if (!user) return null;

    const onboarding = ((user.onboarding as OnboardingState) ?? {}) as OnboardingState;

    const [recipientCount, messageCount, releaseManager] = await Promise.all([
      this.countRows('recipients', userId),
      this.countRows('messages', userId),
      this.hasActiveReleaseManager(userId),
    ]);

    return {
      email: user.email ?? null,
      first_name: user.first_name ?? null,
      account_status: user.account_status ?? 'free',
      activation_status: this.activationStatus(onboarding),
      has_release_manager: releaseManager,
      has_recipients: recipientCount > 0,
      message_count: messageCount,
      created_at: user.created_at ?? null,
    };
  }

  private activationStatus(
    onboarding: OnboardingState,
  ): 'not_started' | 'in_progress' | 'complete' {
    if (typeof onboarding['completed_at'] === 'string') return 'complete';
    const done = ONBOARDING_STEPS.filter((s) => onboarding[s] === true).length;
    return done === 0 ? 'not_started' : 'in_progress';
  }

  private async countRows(table: string, userId: string): Promise<number> {
    const { count } = await this.supabase
      .getClient()
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    return count ?? 0;
  }

  private async hasActiveReleaseManager(userId: string): Promise<boolean> {
    const { data } = await this.supabase
      .getClient()
      .from('release_managers')
      .select('id')
      .eq('user_id', userId)
      .not('status', 'in', '("revoked","declined")')
      .maybeSingle();
    return !!data;
  }
}
