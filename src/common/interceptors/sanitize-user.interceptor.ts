import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

const SENSITIVE_USER_FIELDS = [
  'stripe_customer_id',
  'closing_requested_at',
  'closing_scheduled_at',
  'payment_type',
  'activated_at',
  'trial_ends_at',
];

function sanitizeUser(user: Record<string, any>): Record<string, any> {
  if (!user || typeof user !== 'object') return user;
  const sanitized = { ...user };
  for (const field of SENSITIVE_USER_FIELDS) {
    delete sanitized[field];
  }
  return sanitized;
}

function sanitizeResponse(data: any): any {
  if (!data) return data;

  if (data.id && data.email && data.account_status) {
    return sanitizeUser(data);
  }

  if (data.user && data.user.id) {
    return { ...data, user: sanitizeUser(data.user) };
  }

  return data;
}

@Injectable()
export class SanitizeUserInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map((data) => sanitizeResponse(data)));
  }
}
