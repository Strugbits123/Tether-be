import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { CreateRecipientDto } from './dto/create-recipient.dto.js';
import { ActivityService } from '../activity/activity.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';

@Injectable()
export class RecipientsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
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

    await this.markOnboardingStep(userId, 'add_recipients').catch(() => null);

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
    this.posthog.capture(userId, 'server_recipient_added', {
      relationship: dto.relationship,
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

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------
  private async markOnboardingStep(userId: string, step: string) {
    const { data: user } = await this.supabase
      .getClient()
      .from('users')
      .select('onboarding')
      .eq('id', userId)
      .single();

    if (!user) return;

    const onboarding = (user.onboarding as Record<string, unknown>) ?? {};
    onboarding[step] = true;

    await this.supabase
      .getClient()
      .from('users')
      .update({ onboarding, updated_at: new Date().toISOString() })
      .eq('id', userId);
  }
}
