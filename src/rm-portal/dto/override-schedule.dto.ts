import { IsISO8601 } from 'class-validator';

/**
 * Body for the QA-only delivery-date override. The secret that authorises it is
 * sent as a header, never in the body, so it can't end up in a request log that
 * records payloads.
 */
export class OverrideScheduleDto {
  /** New delivery date/time, ISO 8601. */
  @IsISO8601()
  deliveryScheduledAt: string;
}
