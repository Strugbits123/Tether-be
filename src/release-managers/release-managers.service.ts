import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { CreateReleaseManagerDto } from './dto/create-release-manager.dto.js';
import { ActivityService } from '../activity/activity.service.js';

@Injectable()
export class ReleaseManagersService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly activityService: ActivityService,
  ) {}

  // POST /release-managers
  async create(userId: string, dto: CreateReleaseManagerDto) {
    const name = `${dto.firstName.trim()} ${dto.lastName.trim()}`;
    const email = dto.email.toLowerCase();

    const { data: recipientConflict } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id')
      .eq('user_id', userId)
      .eq('email', email)
      .maybeSingle();

    if (recipientConflict) {
      throw new ConflictException(
        'This person is already a recipient on your account. A Release Manager cannot also be a recipient.',
      );
    }

    await this.supabase
      .getClient()
      .from('release_managers')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .not('status', 'in', '("revoked","declined")');

    const { data, error } = await this.supabase
      .getClient()
      .from('release_managers')
      .insert({
        user_id: userId,
        name,
        email,
        phone: dto.phone ?? null,
        relationship: dto.relationship,
        note: dto.note ?? null,
        status: 'invited',
      })
      .select('id, name, email, phone, relationship, note, status, created_at')
      .single();

    if (error) {
      throw new InternalServerErrorException(
        'Failed to designate Release Manager.',
      );
    }

    await this.markOnboardingStep(userId, 'add_release_manager').catch(
      () => null,
    );

    this.activityService.log(userId, 'release_manager_designated', `Release Manager designated — ${name}`, {
      releaseManagerId: data.id,
      name,
      email,
      relationship: dto.relationship,
    });

    return data;
  }

  // GET /release-managers
  async getActive(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('release_managers')
      .select('id, name, email, phone, relationship, note, status, created_at')
      .eq('user_id', userId)
      .not('status', 'in', '("revoked","declined")')
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        'Failed to fetch Release Manager.',
      );
    }

    return data; // null if none designated — caller decides how to render
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
