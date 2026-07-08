import {
  Injectable,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { SignupDto } from './dto/signup.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { MagicLinkDto } from './dto/magic-link.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { UpdatePasswordDto } from './dto/update-password.dto.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    private readonly posthog: PostHogService,
  ) {}

  async signup(dto: SignupDto) {
    // Pre-flight: check if this email already has a row in public.users.
    // This catches cases where a Google-OAuth user later attempts an
    // email/password signup, which can bypass the identities-array check
    // and trigger a second DB row via the handle_new_user trigger.
    // Wrapped in try/catch so a transient query failure never blocks signup.
    try {
      const { data: existingUser } = await this.supabase
        .getClient()
        .from('users')
        .select('id')
        .eq('email', dto.email.toLowerCase())
        .maybeSingle();

      if (existingUser) {
        throw new ConflictException(
          'An account with this email already exists. Please sign in or reset your password.',
        );
      }
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      // Transient DB error — proceed and let Supabase auth be the authority.
    }

    const { data, error } = await this.supabase.getPublicClient().auth.signUp({
      email: dto.email,
      password: dto.password,
      options: {
        emailRedirectTo: `${this.config.get('FRONTEND_URL')}/auth/callback`,
        data: {
          first_name: dto.first_name ?? null,
          last_name: dto.last_name ?? null,
        },
      },
    });

    if (error) {
      if (error.message.toLowerCase().includes('already registered')) {
        throw new ConflictException(
          'An account with this email already exists. Please sign in or reset your password.',
        );
      }
      throw new BadRequestException(error.message);
    }

    // Supabase returns a fake success for existing emails (anti-enumeration).
    // A genuine new signup has a populated identities array; a duplicate has
    // an empty one. Short-circuit here before any downstream user-row creation.
    if (
      data.user &&
      (!data.user.identities || data.user.identities.length === 0)
    ) {
      throw new ConflictException(
        'An account with this email already exists. Please sign in or reset your password.',
      );
    }

    if (data.user?.id) {
      this.posthog.capture(data.user.id, 'user_signed_up', {
        provider: 'email',
        acquisition_source: dto.acquisition_source ?? null,
        utm_source: dto.utm_source ?? null,
        utm_medium: dto.utm_medium ?? null,
        utm_campaign: dto.utm_campaign ?? null,
        utm_term: dto.utm_term ?? null,
        utm_content: dto.utm_content ?? null,
        referrer: dto.referrer ?? null,
      });
      // Person profile: email is retained for support/lookups; plan_tier seeds
      // segmentation (defaults to 'free' until billing is wired up). No names
      // are sent as person properties — PII guardrail.
      this.posthog.identify(data.user.id, {
        email: data.user.email,
        created_at: new Date().toISOString(),
        plan_tier: 'free',
      });
    }

    return {
      message:
        'Account created. Please check your email to verify your account.',
      user_id: data.user?.id ?? null,
      session: data.session
        ? {
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            expires_at: data.session.expires_at,
          }
        : null,
    };
  }

  async login(dto: LoginDto) {
    const { data, error } = await this.supabase
      .getPublicClient()
      .auth.signInWithPassword({
        email: dto.email,
        password: dto.password,
      });

    if (error) {
      // Generic message to prevent email enumeration
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!data.user.email_confirmed_at) {
      throw new UnauthorizedException(
        'Please verify your email before logging in',
      );
    }

    // Update last login
    await this.supabase
      .getClient()
      .from('users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', data.user.id);

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    };
  }

  async magicLink(dto: MagicLinkDto) {
    const { error } = await this.supabase.getPublicClient().auth.signInWithOtp({
      email: dto.email,
      options: {
        emailRedirectTo: `${this.config.get('FRONTEND_URL')}/auth/callback`,
        shouldCreateUser: false, // only existing users
      },
    });

    if (error) {
      throw new InternalServerErrorException('Failed to send magic link');
    }

    // Always return success to prevent email enumeration
    return {
      message:
        'If an account exists for this email, a login link has been sent.',
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const { error } = await this.supabase
      .getPublicClient()
      .auth.resetPasswordForEmail(dto.email, {
        redirectTo: `${this.config.get('FRONTEND_URL')}/auth/reset-password`,
      });

    if (error) {
      throw new InternalServerErrorException('Failed to send reset email');
    }

    // Always return success to prevent email enumeration
    return {
      message:
        'If an account exists for this email, a password reset link has been sent.',
    };
  }

  async updatePassword(userId: string, dto: UpdatePasswordDto) {
    const { error } = await this.supabase
      .getClient()
      .auth.admin.updateUserById(userId, {
        password: dto.password,
      });

    if (error) {
      throw new InternalServerErrorException('Failed to update password');
    }

    return { message: 'Password updated successfully' };
  }

  async logout(accessToken: string) {
    const { error } = await this.supabase
      .getUserClient(accessToken)
      .auth.signOut();

    if (error) {
      throw new InternalServerErrorException('Failed to logout');
    }

    return { message: 'Logged out successfully' };
  }

  async refreshToken(refreshToken: string) {
    const { data, error } = await this.supabase
      .getClient()
      .auth.refreshSession({ refresh_token: refreshToken });

    if (error || !data.session) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    };
  }

  async getGoogleOAuthUrl() {
    const { data, error } = await this.supabase
      .getClient()
      .auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${this.config.get('FRONTEND_URL')}/auth/callback`,
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      });

    if (error) {
      throw new InternalServerErrorException(
        'Failed to generate Google OAuth URL',
      );
    }

    return { url: data.url };
  }

  // Invoked by the Supabase auth Database Webhook (UPDATE on auth.users).
  // Fires email_verified exactly once, on the null -> confirmed transition.
  handleEmailVerified(payload: {
    type?: string;
    record?: { id?: string; email_confirmed_at?: string | null };
    old_record?: { email_confirmed_at?: string | null };
  }) {
    const record = payload.record;
    const justConfirmed =
      !!record?.email_confirmed_at && !payload.old_record?.email_confirmed_at;

    if (record?.id && justConfirmed) {
      this.posthog.capture(record.id, 'email_verified', { provider: 'email' });
    }
  }
}
