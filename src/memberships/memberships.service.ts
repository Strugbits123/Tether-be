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
    const ownerMap = await this.fetchOwners(ownerIds);

    const memberships = rows.map((row) => {
      const owner = ownerMap.get(row.account_owner_id);

      return {
        id: row.id,
        role: row.role,
        status: row.status,
        account_owner: owner
          ? {
              id: owner.id,
              name: owner.full_name,
              email: owner.email,
              avatar_url: owner.avatar_url ?? null,
            }
          : null,
        is_self: row.account_owner_id === userId,
        ...(row.relationship ? { relationship: row.relationship } : {}),
      };
    });

    return { memberships };
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
