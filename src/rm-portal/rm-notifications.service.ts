import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { timeAgo } from './rm-portal.util.js';

interface MergedNotification {
  id: string;
  source: 'system' | 'contact';
  category: string | null;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
}

@Injectable()
export class RmNotificationsService {
  private readonly logger = new Logger(RmNotificationsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  // GET /rm/notifications
  async listNotifications(userId: string) {
    const now = new Date().toISOString();

    const { data: announcements, error: announcementsError } = await this.supabase
      .getClient()
      .from('announcements')
      .select('id, title, message, category, target_audience, start_date, end_date')
      .eq('is_active', true)
      .in('target_audience', ['all', 'release_managers'])
      .lte('start_date', now);

    if (announcementsError) {
      this.logger.error(`Failed to fetch announcements: ${announcementsError.message}`, announcementsError);
      throw new InternalServerErrorException('Failed to fetch announcements.');
    }

    const { data: reads, error: readsError } = await this.supabase
      .getClient()
      .from('rm_notification_reads')
      .select('notification_id, is_read')
      .eq('user_id', userId);

    if (readsError) {
      this.logger.error(`Failed to fetch notification read state: ${readsError.message}`, readsError);
      throw new InternalServerErrorException('Failed to fetch notification read state.');
    }

    const readMap = new Map((reads ?? []).map((r) => [r.notification_id, r.is_read]));

    const activeAnnouncements = (announcements ?? []).filter((a) => !a.end_date || a.end_date >= now);

    const merged: MergedNotification[] = activeAnnouncements.map((a) => ({
      id: a.id,
      source: 'system' as const,
      category: a.category ?? null,
      // The per-announcement title, falling back to the brand only when the
      // row has none — this was selected above but previously discarded.
      title: a.title ?? 'Tether',
      message: a.message,
      is_read: readMap.get(a.id) ?? false,
      created_at: a.start_date,
    }));

    const { data: activityRows, error: activityError } = await this.supabase
      .getClient()
      .from('activity_log')
      .select('id, event_type, event_label, created_at')
      .eq('user_id', userId)
      .in('event_type', ['invitation_accepted', 'guardian_escalation', 'release_cancelled'])
      .order('created_at', { ascending: false })
      .limit(20);

    // Surfaced like the two queries above — otherwise a real failure is
    // indistinguishable from "no activity" via the `?? []` fallback below.
    if (activityError) {
      this.logger.error(
        `Failed to fetch activity notifications: ${activityError.message}`,
        activityError,
      );
      throw new InternalServerErrorException('Failed to fetch activity notifications.');
    }

    for (const a of activityRows ?? []) {
      merged.push({
        id: a.id,
        source: 'system',
        category: null,
        title: 'Tether',
        message: a.event_label,
        is_read: readMap.get(a.id) ?? false,
        created_at: a.created_at,
      });
    }

    merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return {
      notifications: merged.map((n) => ({ ...n, time_ago: timeAgo(n.created_at) })),
      unread_count: merged.filter((n) => !n.is_read).length,
      total: merged.length,
    };
  }

  private async setReadState(userId: string, notificationId: string, isRead: boolean) {
    const { error } = await this.supabase
      .getClient()
      .from('rm_notification_reads')
      .upsert(
        { user_id: userId, notification_id: notificationId, is_read: isRead, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,notification_id' },
      );

    if (error) {
      this.logger.error(`Failed to update notification read state: ${error.message}`, error);
      throw new InternalServerErrorException('Failed to update notification.');
    }

    return { id: notificationId, is_read: isRead };
  }

  // PATCH /rm/notifications/:id/read
  async markRead(userId: string, notificationId: string) {
    return this.setReadState(userId, notificationId, true);
  }

  // PATCH /rm/notifications/:id/unread
  async markUnread(userId: string, notificationId: string) {
    return this.setReadState(userId, notificationId, false);
  }

  // GET /rm/notifications/unread-count
  async unreadCount(userId: string) {
    const result = await this.listNotifications(userId);
    return { unread_count: result.unread_count };
  }
}
