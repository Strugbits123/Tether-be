import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { SupabaseService } from '../../shared/supabase/supabase.service.js';

export interface AccountContext {
  membershipId: string;
  role: string;
  accountOwnerId: string;
  userId: string;
}

@Injectable()
export class AccountContextGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const membershipId = request.headers['x-account-context'];
    const userId = request.user.id;

    if (!membershipId) {
      // Same status restriction as the explicit-header path below — otherwise a
      // revoked or otherwise inactive owner membership keeps full access simply
      // by omitting the x-account-context header.
      const { data } = await this.supabase
        .getClient()
        .from('account_memberships')
        .select('id')
        .eq('user_id', userId)
        .eq('account_owner_id', userId)
        .eq('role', 'owner')
        .in('status', ['active', 'accepted'])
        .single();

      if (data) {
        request.accountContext = {
          membershipId: data.id,
          role: 'owner',
          accountOwnerId: userId,
          userId,
        } as AccountContext;
        return true;
      }
      throw new ForbiddenException('No account context');
    }

    const { data: membership } = await this.supabase
      .getClient()
      .from('account_memberships')
      .select('id, user_id, account_owner_id, role, status')
      .eq('id', membershipId)
      .eq('user_id', userId)
      .in('status', ['active', 'accepted'])
      .single();

    if (!membership) {
      throw new ForbiddenException('Invalid account context');
    }

    request.accountContext = {
      membershipId: membership.id,
      role: membership.role,
      accountOwnerId: membership.account_owner_id,
      userId,
    } as AccountContext;

    return true;
  }
}
