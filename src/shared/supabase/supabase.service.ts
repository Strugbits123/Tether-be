import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly client: SupabaseClient;

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

  getUserClient(accessToken: string): SupabaseClient {
  const url = this.config.get<string>('SUPABASE_URL')!;
  const key = this.config.get<string>('SUPABASE_SECRET_KEY')!;

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}
}