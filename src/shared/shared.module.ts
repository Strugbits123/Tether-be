import { Global, Module } from '@nestjs/common';
import { SupabaseService } from './supabase/supabase.service';
import { PostHogService } from './posthog/posthog.service.js';
import { AnalyticsService } from './posthog/analytics.service.js';

@Global()
@Module({
  providers: [SupabaseService, PostHogService, AnalyticsService],
  exports: [SupabaseService, PostHogService, AnalyticsService],
})
export class SharedModule {}