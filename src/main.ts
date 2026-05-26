import './instrument.js';
import * as Sentry from '@sentry/nestjs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { TransformInterceptor } from './common/index.js';
import { SanitizeUserInterceptor } from './common/index.js';
import { GlobalExceptionFilter } from './common/index.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');

  app.useGlobalFilters(new GlobalExceptionFilter());

  app.useGlobalInterceptors(
    new TransformInterceptor(),
    new SanitizeUserInterceptor(),
  );

  // Global validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: [
      'http://localhost:3000',
      'https://staging.jointether.com',
      'https://jointether.com',
    ],
    credentials: true,
  });

  Sentry.setupConnectErrorHandler(app);

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`Tether API running on http://localhost:${port}/api/v1`);
}

bootstrap();
