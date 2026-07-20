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
    const { data, error } = await this.supabase
      .getClient()
      .from('account_memberships')
      .select(
        `id, role, status, relationship,
         account_owner:users!account_memberships_account_owner_id_fkey(id, full_name, email, avatar_url)`,
      )
      .eq('user_id', userId)
      .in('status', ['active', 'accepted'])
      .order('created_at', { ascending: true });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch memberships.');
    }

    const memberships = (data ?? []).map((row: any) => {
      const owner = Array.isArray(row.account_owner)
        ? row.account_owner[0]
        : row.account_owner;

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
        is_self: owner?.id === userId,
        ...(row.relationship ? { relationship: row.relationship } : {}),
      };
    });

    return { memberships };
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
      .select(
        `id, role, status, account_owner_id,
         account_owner:users!account_memberships_account_owner_id_fkey(id, full_name, email)`,
      )
      .eq('id', membershipId)
      .eq('user_id', userId)
      .in('status', ['active', 'accepted'])
      .single();

    if (error || !membership) {
      throw new ForbiddenException('Invalid account context');
    }

    return membership;
  }

  private buildContextResponse(membership: any) {
    const owner = Array.isArray(membership.account_owner)
      ? membership.account_owner[0]
      : membership.account_owner;

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
