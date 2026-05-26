import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
  enabled: process.env.NODE_ENV === 'production',
  integrations: [nodeProfilingIntegration()],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
  initialScope: {
    tags: {
      service: 'tether-api',
    },
  },
});
