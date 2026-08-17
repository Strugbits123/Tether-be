import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async log(
    userId: string,
    eventType: string,
    eventLabel: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const result = this.supabase
        .getClient()
        .from('activity_log')
        .insert({
          user_id: userId,
          event_type: eventType,
          event_label: eventLabel,
          metadata: metadata ?? {},
        });
      await result;
    } catch (err) {
      this.logger.error('Activity log failed', err instanceof Error ? err.stack : err);
    }
  }

  async getRecent(userId: string, limit: number = 10) {
    const { data, error } = await this.supabase
      .getClient()
      .from('activity_log')
      .select('id, event_type, event_label, metadata, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw new InternalServerErrorException('Failed to fetch activity');
    return data ?? [];
  }
}
