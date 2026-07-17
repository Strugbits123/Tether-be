import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostHog } from 'posthog-node';

@Injectable()
export class PostHogService implements OnModuleDestroy {
  private readonly logger = new Logger(PostHogService.name);
  private client: PostHog | null = null;
  private readonly environment: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('POSTHOG_API_KEY');
    const host = this.config.get<string>('POSTHOG_HOST') || 'https://us.i.posthog.com';
    // `staging` | `production` | `development`. Set APP_ENV explicitly per
    // Railway environment; falls back to NODE_ENV for local dev.
    this.environment =
      this.config.get<string>('APP_ENV') ||
      this.config.get<string>('NODE_ENV') ||
      'development';

    if (apiKey) {
      this.client = new PostHog(apiKey, { host });
    }
  }

  capture(
    distinctId: string,
    event: string,
    properties?: Record<string, any>,
    // Optional idempotency key (PostHog dedupes events by uuid) — pass the
    // outbox row id so a re-published lifecycle event isn't double-counted.
    uuid?: string,
  ) {
    if (!this.client) return;

    try {
      this.client.capture({
        distinctId,
        event,
        properties: {
          ...properties,
          // Tracking-plan invariants: every event carries the Supabase user id
          // and the deploy environment. `source` distinguishes server-fired
          // events from the browser SDK's.
          user_id: distinctId,
          environment: this.environment,
          source: 'server',
        },
        ...(uuid ? { uuid } : {}),
      });
    } catch (err) {
      this.logger.error('PostHog capture failed', err instanceof Error ? err.stack : err);
    }
  }

  /** Whether a PostHog client is configured (POSTHOG_API_KEY present). */
  isEnabled(): boolean {
    return this.client !== null;
  }

  /**
   * Awaited capture — resolves only after the event is actually sent to PostHog
   * (not just queued). Used by the outbox drainer so an outbox row is marked
   * published only once delivery succeeds. Throws on send failure so the caller
   * leaves the row unpublished for retry.
   *
   * Throws when no client is configured, so a caller can never mistake a
   * dropped (undelivered) event for a successful send — the outbox drainer
   * additionally gates on isEnabled() so it doesn't even attempt this.
   */
  async captureImmediate(
    distinctId: string,
    event: string,
    properties?: Record<string, any>,
    uuid?: string,
  ): Promise<void> {
    if (!this.client) {
      throw new Error('PostHog client not configured (POSTHOG_API_KEY missing)');
    }
    await this.client.captureImmediate({
      distinctId,
      event,
      properties: {
        ...properties,
        user_id: distinctId,
        environment: this.environment,
        source: 'server',
      },
      ...(uuid ? { uuid } : {}),
    });
  }

  identify(distinctId: string, properties?: Record<string, any>) {
    if (!this.client) return;

    try {
      this.client.identify({
        distinctId,
        properties,
      });
    } catch (err) {
      this.logger.error('PostHog identify failed', err instanceof Error ? err.stack : err);
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.shutdown();
    }
  }
}
