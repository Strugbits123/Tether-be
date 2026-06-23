import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostHog } from 'posthog-node';

@Injectable()
export class PostHogService implements OnModuleDestroy {
  private client: PostHog | null = null;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('POSTHOG_API_KEY');
    const host = this.config.get<string>('POSTHOG_HOST') || 'https://us.i.posthog.com';

    if (apiKey) {
      this.client = new PostHog(apiKey, { host });
    }
  }

  capture(distinctId: string, event: string, properties?: Record<string, any>) {
    if (!this.client) return;

    try {
      this.client.capture({
        distinctId,
        event,
        properties: {
          ...properties,
          source: 'server',
        },
      });
    } catch (err) {
      console.error('PostHog capture failed:', err);
    }
  }

  identify(distinctId: string, properties?: Record<string, any>) {
    if (!this.client) return;

    try {
      this.client.identify({
        distinctId,
        properties,
      });
    } catch (err) {
      console.error('PostHog identify failed:', err);
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.shutdown();
    }
  }
}
