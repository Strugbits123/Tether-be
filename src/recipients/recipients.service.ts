import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { CreateRecipientDto } from './dto/create-recipient.dto.js';
import { ActivityService } from '../activity/activity.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { AnalyticsService } from '../shared/posthog/analytics.service.js';

@Injectable()
export class RecipientsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
    private readonly analytics: AnalyticsService,
  ) {}

  // POST /recipients
  async create(userId: string, dto: CreateRecipientDto) {
    const name = `${dto.firstName.trim()} ${dto.lastName.trim()}`;

    // Check for duplicate email on this account
    const { data: existing } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id')
      .eq('user_id', userId)
      .eq('email', dto.email.toLowerCase())
      .maybeSingle();

    if (existing) {
      throw new ConflictException(
        'A recipient with this email address already exists on your account.',
      );
    }

    const { data, error } = await this.supabase
      .getClient()
      .from('recipients')
      .insert({
        user_id: userId,
        name,
        email: dto.email.toLowerCase(),
        phone: dto.phone ?? null,
        relationship: dto.relationship,
        note: dto.note ?? null,
      })
      .select(
        'id, name, email, phone, relationship, note, invitation_status, created_at',
      )
      .single();

    if (error) {
      throw new InternalServerErrorException('Failed to add recipient.');
    }

    await this.analytics
      .markOnboardingStep(userId, 'add_recipients')
      .catch(() => null);

    // Total recipients on the account after this insert.
    const { count: totalRecipients } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    this.activityService.log(
      userId,
      'recipient_added',
      `${name} added as recipient`,
      {
        recipientId: data.id,
        name,
        email: dto.email,
        relationship: dto.relationship,
      },
    );
    this.posthog.capture(userId, 'recipient_added', {
      relationship: dto.relationship,
      // No date-of-birth is collected for recipients, so minor status is
      // unknown rather than false.
      is_minor: null,
      total_recipients_now: totalRecipients ?? null,
    });

    return data;
  }

  // GET /recipients
  async findAll(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('recipients')
      .select(
        'id, name, email, phone, relationship, note, invitation_status, created_at',
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch recipients.');
    }

    return data ?? [];
  }

  // Used by other modules (e.g. chapters) to resolve recipient names for
  // individual assignments without duplicating the query pattern.
  async findByIds(userId: string, ids: string[]) {
    if (ids.length === 0) return [];

    const { data, error } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id, name, relationship')
      .eq('user_id', userId)
      .in('id', ids);

    if (error) {
      throw new InternalServerErrorException('Failed to fetch recipients.');
    }

    return data ?? [];
  }
}
