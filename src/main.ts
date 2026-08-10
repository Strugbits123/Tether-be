import './instrument.js';
import * as Sentry from '@sentry/nestjs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { Logger, ValidationPipe } from '@nestjs/common';
import { TransformInterceptor } from './common/index.js';
import { SanitizeUserInterceptor } from './common/index.js';
import { GlobalExceptionFilter } from './common/index.js';

// Node exits the process on an unhandled rejection, and not every rejection is
// reachable from a request handler — Puppeteer, for example, cleans up its temp
// profile directory asynchronously and on Windows that unlink can fail with
// EBUSY while Chromium still holds the file, taking the whole API down with it.
// Log loudly and stay up: a failed PDF is not a reason to drop every in-flight
// request. Sentry still receives these via its own global handlers.
function installProcessSafetyNets() {
  const logger = new Logger('Process');

  process.on('unhandledRejection', (reason) => {
    logger.error(
      'Unhandled promise rejection (process kept alive)',
      reason instanceof Error ? reason.stack : String(reason),
    );
  });

  // 'uncaughtExceptionMonitor', NOT 'uncaughtException'. Registering an
  // uncaughtException listener *replaces* Node's default behaviour, so the
  // process would keep running after an exception left it in an unknown state —
  // exactly the failure mode this net is supposed to make visible rather than
  // hide. The monitor variant observes the error for logging and then lets Node
  // terminate as it normally would.
  process.on('uncaughtExceptionMonitor', (err) => {
    logger.error(
      'Uncaught exception (process will terminate)',
      err instanceof Error ? err.stack : String(err),
    );
  });
}

async function bootstrap() {
  installProcessSafetyNets();

  const app = await NestFactory.create(AppModule, { rawBody: true });

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
      process.env.FRONTEND_URL ?? 'http://localhost:3000',
      'https://staging.jointether.com',
      'https://jointether.com',
    ],
    credentials: true,
  });

  Sentry.setupConnectErrorHandler(app);

  // Ensures PostHogService.onModuleDestroy() runs on shutdown so queued
  // analytics events are flushed before the process exits.
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  Logger.log(`Tether API running on http://localhost:${port}/api/v1`, 'Bootstrap');
}

bootstrap();
