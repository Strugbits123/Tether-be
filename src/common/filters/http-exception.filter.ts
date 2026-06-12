import * as Sentry from '@sentry/nestjs';
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = this.resolveMessage(exception, status);

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} — ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      Sentry.captureException(exception);
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  /**
   * Normalises any thrown value into a single human-readable string so the
   * frontend can render `message` directly without type-checking it.
   * Validation failures (class-validator) arrive as a string[] — those are
   * joined into one sentence rather than leaked through as an array.
   */
  private resolveMessage(exception: unknown, status: number): string {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();

      if (typeof res === 'string') return res;

      if (res && typeof res === 'object' && 'message' in res) {
        const raw = (res as { message: unknown }).message;
        if (Array.isArray(raw)) return raw.join('; ');
        if (typeof raw === 'string') return raw;
      }

      return exception.message;
    }

    // Never expose internal error details for unhandled (500) exceptions.
    return status >= 500 ? 'Internal server error' : 'Request failed';
  }
}
