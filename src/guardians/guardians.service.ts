import { randomUUID } from 'crypto';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { CreateGuardianData } from './dto/create-guardian.dto.js';

const NON_TERMINAL_FILTER = '("revoked","declined","bounced")';

// Single source of truth for the guardian cap. Also surfaced to the frontend as
// stats.max_guardians (access.service.ts) so the UI greys out its designate
// button from the same number, and mirrored by the @IsIn on the two guardian
// DTOs' priority/order fields.
export const MAX_GUARDIANS = 2;

// Shown verbatim to the account owner when they try to exceed the cap, so it
// reads as product copy rather than a validation string. Update alongside
// MAX_GUARDIANS — the number is spelled out deliberately.
export const MAX_GUARDIANS_MESSAGE =
  'You have already selected two Guardians.';
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
    for (let order = 1; order <= MAX_GUARDIANS; order++) {
      if (!taken.has(order)) return order;
    }
    throw new ConflictException(MAX_GUARDIANS_MESSAGE);
  }

  async create(data: CreateGuardianData) {
    const email = data.email.toLowerCase();
    const active = await this.findActiveByOwner(data.accountId);
    const reactivating = active.some((g) => g.email === email);

    // Only a genuinely new guardian consumes a slot. Without the
    // `reactivating` check, re-designating an existing active guardian (which the
    // upsert below merely updates) was rejected as over the limit.
    if (!reactivating && active.length >= MAX_GUARDIANS) {
      throw new ConflictException(MAX_GUARDIANS_MESSAGE);
    }

    // priority_order arrives from the client (InviteGuardianDto.guardianOrder),
    // so reject a slot another active guardian already holds. This is a
    // best-effort pre-check, not a race-free guarantee — see the note on
    // concurrent designation below.
    if (
      active.some(
        (g) => g.priority_order === data.priorityOrder && g.email !== email,
      )
    ) {
      throw new ConflictException(
        `Guardian slot ${data.priorityOrder} is already taken.`,
      );
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
          email,
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
    const { error } = await this.supabase
      .getClient()
      .from('guardians')
      .update({
        status: 'bounced',
        invitation_bounced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', guardianId);

    // Surfaced rather than swallowed: the bounce webhook would otherwise mark
    // the notification handled while the guardian row stays 'invited', and the
    // discrepancy would leave no trace.
    if (error) {
      throw new InternalServerErrorException('Failed to mark Guardian bounced.');
    }
  }
}
