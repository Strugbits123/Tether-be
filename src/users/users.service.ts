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
    const { data, error } = await this.supabase
      .getClient()
      .from('users')
      .update({
        ...dto,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      throw new NotFoundException('Failed to update profile');
    }

    if (dto.first_name && dto.last_name) {
      await this.completeOnboardingStep(userId, 'finish_account');
    }

    return data;
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
    const { data, error } = await this.supabase
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
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      console.error('completeOnboarding error:', JSON.stringify(error));
      throw new InternalServerErrorException('Failed to complete onboarding');
    }

    return { message: 'Onboarding completed', user: data };
  }

  async saveOnboardingPurposes(userId: string, purposes: string[]) {
    const { data, error } = await this.supabase
      .getClient()
      .from('users')
      .update({
        onboarding: {
          ...(await this.getOnboarding(userId)),
          purposes,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select('onboarding')
      .single();

    if (error)
      throw new InternalServerErrorException('Failed to save purposes');
    return data;
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
