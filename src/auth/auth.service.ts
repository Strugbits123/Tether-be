import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
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
  ) {}

  async signup(dto: SignupDto) {
    const { data, error } = await this.supabase
      .getClient()
      .auth.admin.createUser({
        email: dto.email,
        password: dto.password,
        email_confirm: false,
      });

    if (error) {
      if (error.message.includes('already registered')) {
        throw new BadRequestException(
          'An account with this email already exists',
        );
      }
      throw new InternalServerErrorException(error.message);
    }

    return {
      message:
        'Account created. Please check your email to verify your account.',
      user_id: data.user.id,
    };
  }

  async login(dto: LoginDto) {
    const { data, error } = await this.supabase
      .getClient()
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
    const { error } = await this.supabase.getClient().auth.signInWithOtp({
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
      .getClient()
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
}
