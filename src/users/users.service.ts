import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

@Injectable()
export class UsersService {
  constructor(private readonly supabase: SupabaseService) {}

  async getMe(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('users')
      .select('*')
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
      await this.completeOnboardingStep(userId, 'finish_account');
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
    const { error } = await this.supabase
      .getClient()
      .from('users')
      .update({
        onboarding: {
          finish_account: true,
          add_release_manager: true,
          add_recipients: true,
          add_photos: true,
          create_message: true,
          completed_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) {
      console.error('completeOnboarding error:', JSON.stringify(error));
      throw new InternalServerErrorException('Failed to complete onboarding');
    }

    return { message: 'Onboarding completed' };
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
