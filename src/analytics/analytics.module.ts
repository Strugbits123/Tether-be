import { Module } from '@nestjs/common';
import { AnalyticsCronService } from './analytics-cron.service.js';

// Hosts the scheduled analytics jobs (abandonment events). SupabaseService and
// PostHogService come from the global SharedModule.
@Module({
  providers: [AnalyticsCronService],
})
export class AnalyticsModule {}
