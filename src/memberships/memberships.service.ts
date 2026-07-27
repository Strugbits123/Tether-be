import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';

const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: [
    'view_content',
    'manage_release',
    'view_recipients',
    'download_content',
    'manage_vault',
    'manage_memberships',
  ],
  release_manager: [
    'view_content',
    'manage_release',
    'view_recipients',
    'download_content',
  ],
  guardian: ['view_content'],
  recipient: ['view_content', 'download_content'],
};

@Injectable()
export class MembershipsService {
  constructor(private readonly supabase: SupabaseService) {}

  // GET /auth/memberships
  async listMemberships(userId: string) {
    // account_memberships.account_owner_id references auth.users, not
    // public.users — PostgREST can't embed public.users through that FK, so
    // owners are resolved with a separate lookup instead of a nested select.
    const { data, error } = await this.supabase
      .getClient()
      .from('account_memberships')
      .select('id, role, status, relationship, account_owner_id')
      .eq('user_id', userId)
      .in('status', ['active', 'accepted'])
      .order('created_at', { ascending: true });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch memberships.');
    }

    const rows = data ?? [];
    const ownerIds = [...new Set(rows.map((r) => r.account_owner_id))];
    const [ownerMap, statsMap] = await Promise.all([
      this.fetchOwners(ownerIds),
      this.fetchOwnerStats(ownerIds),
    ]);

    // Matches the frontend's Membership contract (src/lib/api/memberships.ts)
    // exactly — portal/owner_name/stats/release_active, not role/account_owner.
    const memberships = rows.map((row) => {
      const owner = ownerMap.get(row.account_owner_id);
      const stats = statsMap.get(row.account_owner_id) ?? {
        messages: 0,
        documents: 0,
        recipients: 0,
        releaseActive: false,
      };

      return {
        id: row.id,
        portal: row.role,
        is_self: row.account_owner_id === userId,
        owner_name: owner?.full_name ?? null,
        relationship: row.relationship ?? null,
        release_active: stats.releaseActive,
        stats: {
          messages: stats.messages,
          documents: stats.documents,
          recipients: stats.recipients,
        },
      };
    });

    return { memberships };
  }

  private async fetchOwnerStats(ownerIds: string[]) {
    const client = this.supabase.getClient();
    const map = new Map<
      string,
      { messages: number; documents: number; recipients: number; releaseActive: boolean }
    >();

    await Promise.all(
      ownerIds.map(async (ownerId) => {
        const [{ count: messages }, { count: documents }, { count: recipients }, { data: activePlan }] =
          await Promise.all([
            client.from('messages').select('id', { count: 'exact', head: true }).eq('user_id', ownerId),
            client.from('documents').select('id', { count: 'exact', head: true }).eq('user_id', ownerId),
            client.from('recipients').select('id', { count: 'exact', head: true }).eq('user_id', ownerId),
            client.from('release_plans').select('id').eq('user_id', ownerId).eq('status', 'active').maybeSingle(),
          ]);

        map.set(ownerId, {
          messages: messages ?? 0,
          documents: documents ?? 0,
          recipients: recipients ?? 0,
          releaseActive: !!activePlan,
        });
      }),
    );

    return map;
  }

  private async fetchOwners(ownerIds: string[]) {
    if (ownerIds.length === 0) return new Map();

    const { data, error } = await this.supabase
      .getClient()
      .from('users')
      .select('id, full_name, email, avatar_url')
      .in('id', ownerIds);

    if (error) {
      throw new InternalServerErrorException('Failed to fetch memberships.');
    }

    return new Map((data ?? []).map((u) => [u.id, u]));
  }

  // GET /auth/pending-invite-check — used right after email confirmation to
  // decide whether a fresh signup should skip the owner onboarding wizard.
  // Queried with the service-role client because RLS on account_memberships
  // has no read policy for a still-pending invite (user_id is null until
  // acceptance), so the frontend can never resolve this directly against
  // Supabase itself.
  async hasNonOwnerMembership(userId: string, email: string | null | undefined): Promise<boolean> {
    const filter = email
      ? `user_id.eq.${userId},invite_email.eq.${email.toLowerCase()}`
      : `user_id.eq.${userId}`;

    const { data } = await this.supabase
      .getClient()
      .from('account_memberships')
      .select('id')
      .or(filter)
      .neq('role', 'owner')
      .limit(1)
      .maybeSingle();

    return !!data;
  }

  // POST /auth/switch-context
  async switchContext(userId: string, membershipId: string) {
    const membership = await this.getValidMembership(userId, membershipId);
    return this.buildContextResponse(membership);
  }

  // GET /auth/active-context — resolves from the AccountContextGuard result
  async getActiveContext(userId: string, membershipId: string) {
    const membership = await this.getValidMembership(userId, membershipId);
    return this.buildContextResponse(membership);
  }

  private async getValidMembership(userId: string, membershipId: string) {
    const { data: membership, error } = await this.supabase
      .getClient()
      .from('account_memberships')
      .select('id, role, status, account_owner_id')
      .eq('id', membershipId)
      .eq('user_id', userId)
      .in('status', ['active', 'accepted'])
      .single();

    if (error || !membership) {
      throw new ForbiddenException('Invalid account context');
    }

    const ownerMap = await this.fetchOwners([membership.account_owner_id]);
    return { ...membership, account_owner: ownerMap.get(membership.account_owner_id) ?? null };
  }

  private buildContextResponse(membership: any) {
    const owner = membership.account_owner;

    return {
      membership_id: membership.id,
      role: membership.role,
      account_owner: owner
        ? { id: owner.id, name: owner.full_name }
        : null,
      portal: membership.role,
      permissions: ROLE_PERMISSIONS[membership.role] ?? [],
    };
  }
}
