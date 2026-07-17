import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Resend } from 'resend';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { ScreenshotUploadUrlDto } from './dto/screenshot-upload-url.dto.js';
import { SubmitFeedbackDto } from './dto/submit-feedback.dto.js';

// Reduce a client-supplied file name to a safe basename (no path traversal).
function sanitizeFileName(name: string): string {
  const base = name.replace(/^.*[\\/]/, '');
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '.');
  return cleaned.slice(0, 200) || 'file';
}

// HTML-escape any user-controlled value before interpolating it into the
// support email so a submitter can't inject markup into the mailbox.
function escapeHtml(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Collapse CR/LF so user values can't inject additional email headers via the
// subject line.
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
    private readonly config: ConfigService,
  ) {}

  async getScreenshotUploadUrl(userId: string, dto: ScreenshotUploadUrlDto) {
    const storagePath = `${userId}/${randomUUID()}-${sanitizeFileName(dto.file_name)}`;

    const { data, error } = await this.supabase
      .getClient()
      .storage.from('feedback-screenshots')
      .createSignedUploadUrl(storagePath);

    if (error || !data) {
      throw new InternalServerErrorException('Failed to generate upload URL');
    }

    return {
      upload_url: data.signedUrl,
      storage_path: storagePath,
    };
  }

  async submitFeedback(userId: string, dto: SubmitFeedbackDto) {
    const body = this.buildBody(dto);

    // feedback.user_email is NOT NULL by business intent — hydrate the row from
    // the user record. Surface a lookup failure (or a missing email) instead of
    // silently persisting an empty/incorrect email.
    const { data: user, error: userError } = await this.supabase
      .getClient()
      .from('users')
      .select('email, first_name, last_name')
      .eq('id', userId)
      .single();

    if (userError || !user?.email) {
      this.logger.error(
        `Failed to load user ${userId} for feedback: ${userError?.message ?? 'no email on record'}`,
      );
      throw new InternalServerErrorException('Failed to submit feedback');
    }

    const userName =
      user.first_name || user.last_name
        ? `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim()
        : null;

    const { data: feedback, error } = await this.supabase
      .getClient()
      .from('feedback')
      .insert({
        user_id: userId,
        user_email: user.email,
        user_name: userName,
        type: dto.type,
        body,
        page_context: dto.location ?? dto.feedback_type ?? null,
        admin_replied: false,
        created_at: new Date().toISOString(),
      })
      .select('id, type')
      .single();

    if (error || !feedback) {
      // Surface the real DB error instead of swallowing it.
      this.logger.error(
        `Failed to save feedback: ${error?.message ?? 'no row returned'}`,
        error?.details ?? error?.hint ?? '',
      );
      throw new InternalServerErrorException('Failed to save feedback');
    }

    this.activityService
      .log(userId, 'feedback_submitted', 'Submitted feedback', {
        feedbackId: feedback.id,
        type: dto.type,
      })
      .catch(() => null);

    this.posthog.capture(userId, 'feedback_submitted', {
      feedbackId: feedback.id,
      type: dto.type,
      location: dto.location,
      feedback_type: dto.feedback_type,
    });

    this.sendEmail(userId, dto, feedback.id).catch((err) => {
      this.logger.error('Failed to send feedback email', err);
    });

    return {
      id: feedback.id,
      type: dto.type,
      message: 'Thank you for your feedback!',
    };
  }

  private buildBody(dto: SubmitFeedbackDto): string {
    if (dto.type === 'bug_report') {
      return [
        dto.location ? `Location: ${dto.location}` : null,
        dto.description,
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    if (dto.type === 'feature_request') {
      return [
        dto.feature_description
          ? `Feature: ${dto.feature_description}`
          : null,
        dto.feature_benefit ? `Benefit: ${dto.feature_benefit}` : null,
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    // general_feedback
    return [
      dto.feedback_type ? `Type: ${dto.feedback_type}` : null,
      dto.description,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private async sendEmail(
    userId: string,
    dto: SubmitFeedbackDto,
    feedbackId: string,
  ) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) return;

    const { data: user } = await this.supabase
      .getClient()
      .from('users')
      .select('first_name, last_name, email')
      .eq('id', userId)
      .single();

    const userName = user
      ? `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim()
      : 'Unknown User';
    const userEmail = user?.email ?? '';

    let screenshotHtml = '';
    // Only mint a signed URL for an object the caller actually owns — the path
    // must live under their own `${userId}/` prefix (the same prefix
    // getScreenshotUploadUrl enforces). A client-supplied path pointing at
    // another object in the bucket is ignored, not signed.
    if (dto.screenshot_path && dto.screenshot_path.startsWith(`${userId}/`)) {
      const { data: urlData } = await this.supabase
        .getClient()
        .storage.from('feedback-screenshots')
        .createSignedUrl(dto.screenshot_path, 3600);
      if (urlData?.signedUrl) {
        screenshotHtml = `<p><strong>Screenshot:</strong> <a href="${escapeHtml(urlData.signedUrl)}">View screenshot</a></p>`;
      }
    } else if (dto.screenshot_path) {
      this.logger.warn(
        `Ignoring screenshot_path outside caller's prefix for user ${userId}`,
      );
    }

    const subject = this.buildSubject(dto, userName);
    const html = this.buildEmailHtml(dto, userName, userEmail, feedbackId, screenshotHtml);

    const resend = new Resend(apiKey);
    await resend.emails.send({
      from: 'Tether Feedback <feedback@jointether.com>',
      to: ['support@jointether.com'],
      subject,
      html,
    });
  }

  private buildSubject(dto: SubmitFeedbackDto, userName: string): string {
    const name = singleLine(userName);
    if (dto.type === 'bug_report') {
      const loc = dto.location ? ` — ${singleLine(dto.location)}` : '';
      return `🐛 Bug Report from ${name}${loc}`;
    }
    if (dto.type === 'feature_request') {
      return `💡 Feature Request from ${name}`;
    }
    const ft = dto.feedback_type ? ` (${singleLine(dto.feedback_type)})` : '';
    return `💬 Feedback${ft} from ${name}`;
  }

  private buildEmailHtml(
    dto: SubmitFeedbackDto,
    userName: string,
    userEmail: string,
    feedbackId: string,
    screenshotHtml: string,
  ): string {
    // Every dynamic value is HTML-escaped. dto.type is enum-validated but
    // escaped anyway for defense in depth.
    const rows: string[] = [
      `<p><strong>User:</strong> ${escapeHtml(userName)} &lt;${escapeHtml(userEmail)}&gt;</p>`,
      `<p><strong>Type:</strong> ${escapeHtml(dto.type.replace(/_/g, ' '))}</p>`,
      `<p><strong>Feedback ID:</strong> ${escapeHtml(feedbackId)}</p>`,
      `<p><strong>Submitted:</strong> ${new Date().toUTCString()}</p>`,
      '<hr>',
    ];

    if (dto.type === 'bug_report') {
      if (dto.location) rows.push(`<p><strong>Location:</strong> ${escapeHtml(dto.location)}</p>`);
      if (dto.description) rows.push(`<p><strong>Description:</strong></p><p>${escapeHtml(dto.description)}</p>`);
    } else if (dto.type === 'feature_request') {
      if (dto.feature_description) rows.push(`<p><strong>Feature:</strong></p><p>${escapeHtml(dto.feature_description)}</p>`);
      if (dto.feature_benefit) rows.push(`<p><strong>Benefit:</strong></p><p>${escapeHtml(dto.feature_benefit)}</p>`);
    } else {
      if (dto.feedback_type) rows.push(`<p><strong>Feedback type:</strong> ${escapeHtml(dto.feedback_type)}</p>`);
      if (dto.description) rows.push(`<p><strong>Description:</strong></p><p>${escapeHtml(dto.description)}</p>`);
    }

    if (screenshotHtml) rows.push(screenshotHtml);

    return `<div style="font-family:sans-serif;max-width:600px">${rows.join('')}</div>`;
  }
}
