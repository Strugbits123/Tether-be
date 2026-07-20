import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio from 'twilio';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly client: ReturnType<typeof twilio> | null;
  private readonly fromNumber: string | null;

  constructor(private readonly config: ConfigService) {
    const accountSid = this.config.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.config.get<string>('TWILIO_AUTH_TOKEN');
    this.fromNumber = this.config.get<string>('TWILIO_PHONE_NUMBER') ?? null;

    if (!accountSid || !authToken || !this.fromNumber) {
      this.logger.warn('Twilio not configured — SMS will not be sent');
      this.client = null;
    } else {
      this.client = twilio(accountSid, authToken);
    }
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  // Best-effort — never throws. Callers treat SMS as a supplementary channel
  // to email, not the primary delivery mechanism.
  async send(to: string, body: string): Promise<void> {
    if (!this.client || !this.fromNumber) return;
    try {
      await this.client.messages.create({ to, from: this.fromNumber, body });
    } catch (err) {
      this.logger.error(`Failed to send SMS to ${to}`, err instanceof Error ? err.stack : err);
    }
  }
}
