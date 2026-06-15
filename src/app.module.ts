import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { SharedModule } from './shared/shared.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { HealthModule } from './health/health.module.js';
import { RecipientsModule } from './recipients/recipients.module.js';
import { ReleaseManagersModule } from './release-managers/release-managers.module.js';
import { PhotosModule } from './photos/photos.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { ActivityModule } from './activity/activity.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000,
          limit: 100,
        },
      ],
    }),
    SharedModule,
    AuthModule,
    UsersModule,
    HealthModule,
    RecipientsModule,
    ReleaseManagersModule,
    PhotosModule,
    MessagesModule,
    DocumentsModule,
    ActivityModule,
  ],
})
export class AppModule {}
