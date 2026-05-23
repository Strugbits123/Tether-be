import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { CreateReleaseManagerDto } from './dto/create-release-manager.dto.js';

@Injectable()
export class ReleaseManagersService {
  constructor(private readonly supabase: SupabaseService) {}

  async designate(userId: string, dto: CreateReleaseManagerDto) {
    const { data: existingRecipient } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id')
      .eq('user_id', userId)
      .eq('email', dto.email)
      .maybeSingle();

    if (existingRecipient) {
      throw new BadRequestException(
        'This person is already a recipient on your account. A Release Manager cannot also be a recipient.',
      );
    }

    await this.supabase
      .getClient()
      .from('release_managers')
      .update({ status: 'revoked', revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .not('status', 'in', '("revoked","declined")');

    const { data, error } = await this.supabase
      .getClient()
      .from('release_managers')
      .insert({
        user_id: userId,
        name: dto.name,
        email: dto.email,
        relationship: dto.relationship,
        status: 'invited',
        invitation_sent_at: new Date().toISOString(),
        invitation_expires_at: new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new InternalServerErrorException(
        'Failed to designate Release Manager',
      );
    }

    await this.markOnboardingStep(userId, 'add_release_manager');

    return data;
  }

  async getActive(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('release_managers')
      .select('*')
      .eq('user_id', userId)
      .not('status', 'in', '("revoked","declined")')
      .maybeSingle();

    if (error)
      throw new InternalServerErrorException('Failed to fetch Release Manager');
    if (!data)
      throw new NotFoundException('No active Release Manager designated');
    return data;
  }

  private async markOnboardingStep(userId: string, step: string) {
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

    await this.supabase
      .getClient()
      .from('users')
      .update({ onboarding, updated_at: new Date().toISOString() })
      .eq('id', userId);
  }
}
