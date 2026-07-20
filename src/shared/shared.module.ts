import { Global, Module } from '@nestjs/common';
import { SupabaseService } from './supabase/supabase.service';
import { PostHogService } from './posthog/posthog.service.js';
import { AnalyticsService } from './posthog/analytics.service.js';
import { EmailService } from './email/email.service.js';
import { NotificationLogService } from './notification-log/notification-log.service.js';

@Global()
@Module({
  providers: [
    SupabaseService,
    PostHogService,
    AnalyticsService,
    EmailService,
    NotificationLogService,
  ],
  exports: [
    SupabaseService,
    PostHogService,
    AnalyticsService,
    EmailService,
    NotificationLogService,
  ],
})
export class SharedModule {}