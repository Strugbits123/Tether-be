import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
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
  constructor(private readonly supabase: SupabaseService) {}

  // GET /rm/notifications
  async listNotifications(userId: string, category?: string) {
    const now = new Date().toISOString();

    const { data: announcements, error: announcementsError } = await this.supabase
      .getClient()
      .from('announcements')
      .select('id, title, message, category, target_audience, start_date, end_date')
      .eq('is_active', true)
      .in('target_audience', ['all', 'release_managers'])
      .lte('start_date', now);

    if (announcementsError) {
      throw new InternalServerErrorException('Failed to fetch announcements.');
    }

    const { data: dismissals } = await this.supabase
      .getClient()
      .from('announcement_dismissals')
      .select('announcement_id, dismissed_at')
      .eq('user_id', userId);

    const dismissedIds = new Set((dismissals ?? []).map((d) => d.announcement_id));
    const dismissalMap = new Map((dismissals ?? []).map((d) => [d.announcement_id, d.dismissed_at]));

    const activeAnnouncements = (announcements ?? []).filter(
      (a) => !a.end_date || a.end_date >= now,
    );

    const merged: MergedNotification[] = activeAnnouncements
      .filter((a) => !dismissedIds.has(a.id))
      .map((a) => ({
        id: a.id,
        source: 'system' as const,
        category: a.category ?? null,
        title: 'Tether',
        message: a.message,
        is_read: dismissalMap.has(a.id),
        created_at: a.start_date,
      }));

    const { data: activityRows } = await this.supabase
      .getClient()
      .from('activity_log')
      .select('id, event_type, event_label, created_at')
      .eq('user_id', userId)
      .in('event_type', ['invitation_accepted', 'guardian_escalation', 'release_cancelled'])
      .order('created_at', { ascending: false })
      .limit(20);

    for (const a of activityRows ?? []) {
      merged.push({
        id: a.id,
        source: 'system',
        category: null,
        title: 'Tether',
        message: a.event_label,
        is_read: false,
        created_at: a.created_at,
      });
    }

    merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const filtered =
      category && category !== 'all'
        ? merged.filter((n) => n.category === category)
        : merged;

    return {
      notifications: filtered.map((n) => ({ ...n, time_ago: timeAgo(n.created_at) })),
      unread_count: merged.filter((n) => !n.is_read).length,
      total: filtered.length,
    };
  }

  // PATCH /rm/notifications/:id/read
  async markRead(userId: string, announcementId: string) {
    const { error } = await this.supabase
      .getClient()
      .from('announcement_dismissals')
      .upsert(
        { user_id: userId, announcement_id: announcementId, dismissed_at: new Date().toISOString() },
        { onConflict: 'user_id,announcement_id' },
      );

    if (error) {
      throw new InternalServerErrorException('Failed to mark notification as read.');
    }

    return { id: announcementId, is_read: true };
  }

  // DELETE /rm/notifications/:id
  async dismiss(userId: string, announcementId: string) {
    const { error } = await this.supabase
      .getClient()
      .from('announcement_dismissals')
      .upsert(
        { user_id: userId, announcement_id: announcementId, dismissed_at: new Date().toISOString() },
        { onConflict: 'user_id,announcement_id' },
      );

    if (error) {
      throw new NotFoundException('Notification not found.');
    }

    return { message: 'Notification dismissed' };
  }

  // GET /rm/notifications/unread-count
  async unreadCount(userId: string) {
    const result = await this.listNotifications(userId);
    return { unread_count: result.unread_count };
  }
}
