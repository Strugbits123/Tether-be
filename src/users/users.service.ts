import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ImageMimeType } from './dto/avatar-upload.dto.js';
import { ActivityService } from '../activity/activity.service.js';

@Injectable()
export class UsersService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
  ) {}

  async getMe(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('users')
      .select(
        'id, email, first_name, last_name, full_name, date_of_birth, zip_code, state, age_group, gender, relationship_status, phone_number, avatar_url, sms_opted_in, account_status, auth_provider, role, onboarding, created_at, updated_at, last_login_at',
      )
      .eq('id', userId)
      .single();

    if (error || !data) {
      throw new NotFoundException('User not found');
    }

    return data;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const { error } = await this.supabase
      .getClient()
      .from('users')
      .update({
        ...dto,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) {
      throw new InternalServerErrorException('Failed to update profile');
    }

    if (dto.first_name && dto.last_name) {
      const { data: currentUser } = await this.supabase
        .getClient()
        .from('users')
        .select('onboarding')
        .eq('id', userId)
        .single();
      const wasCompleted =
        (currentUser?.onboarding as Record<string, unknown> | null)
          ?.finish_account === true;

      await this.completeOnboardingStep(userId, 'finish_account');

      if (!wasCompleted) {
        this.activityService.log(userId, 'profile_completed', 'Profile completed', {});
        this.posthog.capture(userId, 'server_profile_completed', {
          has_avatar: !!dto.avatar_url,
        });
        this.posthog.identify(userId, {
          first_name: dto.first_name,
          last_name: dto.last_name,
          state: dto.state,
          age_group: dto.age_group,
        });
      }
    }

    // Fetch updated row separately
    return this.getMe(userId);
  }

  async completeOnboardingStep(userId: string, step: string) {
    const { data: user } = await this.supabase
      .getClient()
      .from('users')
      .select('onboarding')
      .eq('id', userId)
      .single();

    if (!user) return;

    const onboarding = user.onboarding as Record<
      string,
      boolean | string | null
    >;
    onboarding[step] = true;

    const steps = [
      'finish_account',
      'add_release_manager',
      'add_recipients',
      'add_photos',
      'create_message',
    ];
    const allComplete = steps.every((s) => onboarding[s] === true);
    if (allComplete) {
      onboarding['completed_at'] = new Date().toISOString();
    }

    await this.supabase
      .getClient()
      .from('users')
      .update({ onboarding, updated_at: new Date().toISOString() })
      .eq('id', userId);
  }

  async completeOnboarding(userId: string) {
    // Only stamp completed_at — preserve the real per-step flags, which are set
    // individually when a recipient/release manager/photo/message is created.
    // Skipped steps must stay false.
    const { data: user, error: fetchError } = await this.supabase
      .getClient()
      .from('users')
      .select('onboarding')
      .eq('id', userId)
      .single();

    if (fetchError || !user) {
      throw new NotFoundException('User not found');
    }

    const onboarding = (user.onboarding as Record<string, unknown>) ?? {};
    onboarding['completed_at'] = new Date().toISOString();

    const { error } = await this.supabase
      .getClient()
      .from('users')
      .update({
        onboarding,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) {
      throw new InternalServerErrorException('Failed to complete onboarding');
    }

    return { message: 'Onboarding completed' };
  }

  async getAvatarUploadUrl(userId: string, fileType: ImageMimeType) {
    const rawExt = fileType.split('/')[1];
    const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
    const storagePath = `${userId}/avatar.${ext}`;

    const { data, error } = await this.supabase
      .getClient()
      .storage.from('avatars')
      .createSignedUploadUrl(storagePath, { upsert: true });

    if (error) {
      throw new InternalServerErrorException('Failed to generate upload URL');
    }

    const { data: publicUrlData } = this.supabase
      .getClient()
      .storage.from('avatars')
      .getPublicUrl(storagePath);

    return {
      signedUploadUrl: data.signedUrl,
      storagePath,
      publicUrl: publicUrlData.publicUrl,
    };
  }

  async saveOnboardingPurposes(userId: string, purposes: string[]) {
    const currentOnboarding = await this.getOnboarding(userId);

    const { error } = await this.supabase
      .getClient()
      .from('users')
      .update({
        onboarding: {
          ...currentOnboarding,
          purposes,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) {
      throw new InternalServerErrorException('Failed to save purposes');
    }

    return { message: 'Purposes saved' };
  }

  async getOnboardingState(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('users')
      .select('onboarding')
      .eq('id', userId)
      .single();

    if (error || !data) {
      throw new NotFoundException('User not found');
    }

    return { onboarding: data.onboarding ?? {} };
  }

  private async getOnboarding(userId: string) {
    const { data } = await this.supabase
      .getClient()
      .from('users')
      .select('onboarding')
      .eq('id', userId)
      .single();
    return data?.onboarding ?? {};
  }
}
