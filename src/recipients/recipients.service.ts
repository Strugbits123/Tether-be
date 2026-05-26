import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { CreateRecipientDto } from './dto/create-recipient.dto.js';

@Injectable()
export class RecipientsService {
  constructor(private readonly supabase: SupabaseService) {}

  async create(userId: string, dto: CreateRecipientDto) {
    const { data: existingRM } = await this.supabase
      .getClient()
      .from('release_managers')
      .select('id')
      .eq('user_id', userId)
      .eq('email', dto.email)
      .not('status', 'in', '("revoked","declined")')
      .maybeSingle();

    if (existingRM) {
      throw new BadRequestException(
        'This person is already your Release Manager. A recipient cannot also be the Release Manager.',
      );
    }

    const { data, error } = await this.supabase
      .getClient()
      .from('recipients')
      .insert({
        user_id: userId,
        name: dto.name,
        email: dto.email,
        relationship: dto.relationship,
        is_minor: dto.is_minor ?? false,
        date_of_birth: dto.date_of_birth ?? null,
        custodial_adult_email: dto.custodial_adult_email ?? null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new BadRequestException(
          'This person is already a recipient on your account.',
        );
      }
      throw new InternalServerErrorException('Failed to add recipient');
    }

    await this.markOnboardingStep(userId, 'add_recipients');

    return data;
  }

  async findAll(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('recipients')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error)
      throw new InternalServerErrorException('Failed to fetch recipients');
    return data;
  }

  async remove(userId: string, recipientId: string) {
    const { error } = await this.supabase
      .getClient()
      .from('recipients')
      .delete()
      .eq('id', recipientId)
      .eq('user_id', userId);

    if (error)
      throw new InternalServerErrorException('Failed to remove recipient');
    return { message: 'Recipient removed' };
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
