import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly client: SupabaseClient;
  private publicClient?: SupabaseClient;
  private readonly userClients = new Map<string, SupabaseClient>();
  private static readonly USER_CLIENT_CACHE_MAX = 100;

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
    const cached = this.userClients.get(accessToken);
    if (cached) return cached;

    const url = this.config.get<string>('SUPABASE_URL')!;
    const key = this.config.get<string>('SUPABASE_SECRET_KEY')!;

    const client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    if (this.userClients.size >= SupabaseService.USER_CLIENT_CACHE_MAX) {
      const oldest = this.userClients.keys().next().value as string;
      this.userClients.delete(oldest);
    }
    this.userClients.set(accessToken, client);
    return client;
  }
}