import { Module } from '@nestjs/common';
import { ConfigModule, ConfigModuleOptions } from '@nestjs/config';

const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'MUX_TOKEN_ID',
  'MUX_TOKEN_SECRET',
  'POSTHOG_API_KEY',
  'DEEPGRAM_API_KEY',
] as const;

const validateEnv: ConfigModuleOptions['validate'] = (config: Record<string, unknown>) => {
  const missing = REQUIRED_ENV_VARS.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return config;
};
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { SharedModule } from './shared/shared.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { HealthModule } from './health/health.module.js';
import { RecipientsModule } from './recipients/recipients.module.js';
import { ReleaseManagersModule } from './release-managers/release-managers.module.js';
import { PhotosModule } from './photos/photos.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { ChaptersModule } from './chapters/chapters.module.js';
import { ActivityModule } from './activity/activity.module.js';
import { ContentModule } from './content/content.module.js';
import { MemoirModule } from './memoir/memoir.module.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000,
          limit: 100,
        },
      ],
    }),
    ScheduleModule.forRoot(),
    SharedModule,
    AuthModule,
    UsersModule,
    HealthModule,
    RecipientsModule,
    ReleaseManagersModule,
    PhotosModule,
    MessagesModule,
    DocumentsModule,
    ChaptersModule,
    ActivityModule,
    ContentModule,
    MemoirModule,
    FeedbackModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
