import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      service: 'tether-api',
      timestamp: new Date().toISOString(),
    };
  }

  // REMOVE AFTER SENTRY VERIFICATION
  @Get('error-test')
  errorTest() {
    throw new Error('Sentry test error');
  }
}
