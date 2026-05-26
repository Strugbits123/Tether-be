import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../../shared/supabase/supabase.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No access token provided');
    }

    const { data, error } = await this.supabase
      .getClient()
      .auth.getUser(token);

    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    request.user = data.user;
    request.accessToken = token;

    return true;
  }

  private extractToken(request: any): string | null {
    const authHeader = request.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    return null;
  }
}