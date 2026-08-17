import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly client: SupabaseClient;
  private publicClient?: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('SUPABASE_URL');
    const key = this.config.get<string>('SUPABASE_SECRET_KEY');

    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be defined');
    }

    this.client = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  getClient(): SupabaseClient {
    return this.client;
  }

  /**
   * Client keyed with the publishable (anon) key — use for end-user auth flows
   * like signUp, which run as the user rather than the service role. The
   * service-role client (getClient) bypasses the public signup path and would
   * not surface Supabase's anti-enumeration duplicate signal.
   */
  getPublicClient(): SupabaseClient {
    if (!this.publicClient) {
      const url = this.config.get<string>('SUPABASE_URL');
      const key = this.config.get<string>('SUPABASE_PUBLISHABLE_KEY');

      if (!url || !key) {
        throw new Error(
          'SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be defined',
        );
      }

      this.publicClient = createClient(url, key, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
    }
    return this.publicClient;
  }

  getUserClient(accessToken: string): SupabaseClient {
    const url = this.config.get<string>('SUPABASE_URL')!;
    const key = this.config.get<string>('SUPABASE_SECRET_KEY')!;

    return createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }
}