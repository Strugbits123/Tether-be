import { Global, Module } from '@nestjs/common';
import { SupabaseService } from './supabase/supabase.service';
import { PostHogService } from './posthog/posthog.service.js';

@Global()
@Module({
  providers: [SupabaseService, PostHogService],
  exports: [SupabaseService, PostHogService],
})
export class SharedModule {}