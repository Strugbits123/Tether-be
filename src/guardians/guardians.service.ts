import { randomUUID } from 'crypto';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { CreateGuardianData } from './dto/create-guardian.dto.js';

const NON_TERMINAL_FILTER = '("revoked","declined","bounced")';
const GUARDIAN_COLUMNS =
  'id, account_id, guardian_user_id, name, email, relationship, status, invitation_token, invitation_sent_at, accepted_at, declined_at, revoked_at, priority_order, created_at';

@Injectable()
export class GuardiansService {
  constructor(private readonly supabase: SupabaseService) {}

  async findActiveByOwner(ownerId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('guardians')
      .select(GUARDIAN_COLUMNS)
      .eq('account_id', ownerId)
      .not('status', 'in', NON_TERMINAL_FILTER)
      .order('priority_order', { ascending: true });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch guardians.');
    }
    return data ?? [];
  }

  async countActiveByOwner(ownerId: string): Promise<number> {
    const { count, error } = await this.supabase
      .getClient()
      .from('guardians')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ownerId)
      .not('status', 'in', NON_TERMINAL_FILTER);

    if (error) {
      throw new InternalServerErrorException('Failed to count guardians.');
    }
    return count ?? 0;
  }

  async nextPriorityOrder(ownerId: string): Promise<number> {
    const existing = await this.findActiveByOwner(ownerId);
    const taken = new Set(existing.map((g) => g.priority_order));
    for (let order = 1; order <= 3; order++) {
      if (!taken.has(order)) return order;
    }
    throw new ConflictException('Maximum of 3 Guardians already designated.');
  }

  async create(data: CreateGuardianData) {
    const count = await this.countActiveByOwner(data.accountId);
    if (count >= 3) {
      throw new ConflictException('Maximum of 3 Guardians already designated.');
    }

    // `guardians` has a unique (account_id, email) constraint, and revoking a
    // guardian is a soft-delete (the row stays with status: 'revoked') — so
    // re-designating the same recipient later must reactivate that row
    // instead of inserting a duplicate, which would violate the constraint.
    // Every lifecycle field is reset explicitly since upsert only applies
    // column defaults on a genuine insert, not on the update branch.
    const { data: guardian, error } = await this.supabase
      .getClient()
      .from('guardians')
      .upsert(
        {
          account_id: data.accountId,
          guardian_user_id: data.userId ?? null,
          name: data.name,
          email: data.email.toLowerCase(),
          relationship: data.relationship,
          priority_order: data.priorityOrder,
          status: 'invited',
          invitation_token: randomUUID(),
          invitation_sent_at: new Date().toISOString(),
          accepted_at: null,
          declined_at: null,
          revoked_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id,email' },
      )
      .select(GUARDIAN_COLUMNS)
      .single();

    if (error || !guardian) {
      throw new InternalServerErrorException('Failed to designate Guardian.');
    }
    return guardian;
  }

  async findByEmail(ownerId: string, email: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('guardians')
      .select(GUARDIAN_COLUMNS)
      .eq('account_id', ownerId)
      .eq('email', email.toLowerCase())
      .not('status', 'in', NON_TERMINAL_FILTER)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException('Failed to fetch guardian.');
    }
    return data;
  }

  async linkUser(guardianId: string, userId: string) {
    const { error } = await this.supabase
      .getClient()
      .from('guardians')
      .update({
        guardian_user_id: userId,
        status: 'accepted',
        accepted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', guardianId);

    if (error) {
      throw new InternalServerErrorException('Failed to link Guardian account.');
    }
  }

  async revoke(guardianId: string) {
    const { error } = await this.supabase
      .getClient()
      .from('guardians')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', guardianId);

    if (error) {
      throw new InternalServerErrorException('Failed to revoke Guardian.');
    }
  }

  async markBounced(guardianId: string) {
    await this.supabase
      .getClient()
      .from('guardians')
      .update({
        status: 'bounced',
        invitation_bounced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', guardianId);
  }
}
