import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

function escapeHtml(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend | null;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.warn('RESEND_API_KEY not configured — emails will not be sent');
      this.resend = null;
    } else {
      this.resend = new Resend(apiKey);
    }
  }

  async sendReleaseManagerInvitation(params: {
    to: string;
    rmName: string;
    ownerName: string;
    ownerEmail: string;
    acceptUrl: string;
  }): Promise<string | null> {
    return this.send({
      to: params.to,
      subject: `${params.ownerName} has chosen you as their Release Manager on Tether`,
      html: this.buildRmInvitationHtml(params),
    });
  }

  async sendGuardianInvitation(params: {
    to: string;
    guardianName: string;
    ownerName: string;
    rmName: string | null;
    order: number;
    acceptUrl: string;
  }): Promise<string | null> {
    return this.send({
      to: params.to,
      subject: `${params.ownerName} has named you as a Guardian on Tether`,
      html: this.buildGuardianInvitationHtml(params),
    });
  }

  async sendRecipientNotification(params: {
    to: string;
    recipientName: string;
    ownerName: string;
    signupUrl: string;
  }): Promise<string | null> {
    return this.send({
      to: params.to,
      subject: `${params.ownerName} has included you in their Tether legacy plan`,
      html: this.buildRecipientNotificationHtml(params),
    });
  }

  async sendReleaseManagerReminder(params: {
    to: string;
    rmName: string;
    ownerName: string;
    acceptUrl: string;
  }): Promise<string | null> {
    const rmName = escapeHtml(params.rmName);
    const ownerName = escapeHtml(params.ownerName);
    const acceptUrl = escapeHtml(params.acceptUrl);
    return this.send({
      to: params.to,
      subject: `Reminder: ${params.ownerName} is waiting for you on Tether`,
      html: `<div style="font-family:sans-serif;max-width:600px">
<p>Hi ${rmName},</p>
<p>${ownerName} is waiting for you to accept your Release Manager role on Tether. This role lets you manage the delivery of ${ownerName}'s digital legacy when the time comes.</p>
<p><a href="${acceptUrl}">Accept &amp; Set Up Your Account</a></p>
<p>— The Tether Team</p>
</div>`,
    });
  }

  // Returns the Resend message id (for notification_log correlation), or null
  // if Resend isn't configured / the caller should not expect a webhook event.
  private async send(params: {
    to: string;
    subject: string;
    html: string;
  }): Promise<string | null> {
    if (!this.resend) return null;

    const { data, error } = await this.resend.emails.send({
      from: 'Tether <no-reply@jointether.com>',
      to: [params.to],
      subject: params.subject,
      html: params.html,
    });

    if (error) {
      throw new Error(`Resend send failed: ${error.message ?? 'unknown error'}`);
    }

    return data?.id ?? null;
  }

  private buildRmInvitationHtml(params: {
    rmName: string;
    ownerName: string;
    ownerEmail: string;
    to: string;
    acceptUrl: string;
  }): string {
    const rmName = escapeHtml(params.rmName);
    const ownerName = escapeHtml(params.ownerName);
    const ownerEmail = escapeHtml(params.ownerEmail);
    const to = escapeHtml(params.to);
    const acceptUrl = escapeHtml(params.acceptUrl);

    return `<div style="font-family:sans-serif;max-width:600px">
<p>Hi ${rmName},</p>
<p>${ownerName} has designated you as their Release Manager on Tether — the person trusted to carry out their final digital wishes.</p>
<p><strong>What this means</strong></p>
<p>As ${ownerName}'s Release Manager, you will:</p>
<ul>
<li>Access and review all content ${ownerName} has prepared for their loved ones — messages, photos, documents, and memoir chapters</li>
<li>Initiate the release process when the time comes</li>
<li>Manage the delivery of content to ${ownerName}'s designated recipients</li>
<li>Ensure everything reaches the right people securely</li>
</ul>
<p>This role carries no legal authority over ${ownerName}'s estate, finances, or property. It is limited to managing the delivery of digital content stored in Tether.</p>
<p><strong>What happens next</strong></p>
<ol>
<li>Click the button below to accept this role and set up your Release Manager account</li>
<li>Complete your profile so we can verify your identity</li>
<li>You'll have access to an overview of ${ownerName}'s vault — you won't see the actual content until the release is initiated</li>
</ol>
<p><a href="${acceptUrl}">Accept &amp; Set Up Your Account</a></p>
<p>If you have questions about this role, you can reach us at support@jointether.com.</p>
<p>If you believe this was sent in error, you can ignore this email. No action will be taken unless you accept.</p>
<p>— The Tether Team</p>
<p style="color:#888;font-size:12px">This email was sent to ${to} because ${ownerName} (${ownerEmail}) designated you as their Release Manager on Tether.</p>
</div>`;
  }

  private buildGuardianInvitationHtml(params: {
    guardianName: string;
    ownerName: string;
    rmName: string | null;
    order: number;
    acceptUrl: string;
  }): string {
    const guardianName = escapeHtml(params.guardianName);
    const ownerName = escapeHtml(params.ownerName);
    const rmName = escapeHtml(params.rmName ?? 'their Release Manager');
    const acceptUrl = escapeHtml(params.acceptUrl);

    return `<div style="font-family:sans-serif;max-width:600px">
<p>Hi ${guardianName},</p>
<p>${ownerName} has designated you as a Guardian on Tether — a backup role in case their primary Release Manager is unable to act.</p>
<p><strong>What this means</strong></p>
<p>As a Guardian, you will only be contacted if ${ownerName}'s Release Manager (${rmName}) is unable to fulfill their duties. In that case, you would step in to manage the release of ${ownerName}'s digital legacy to their designated recipients.</p>
<p>Until that happens, you have no access to ${ownerName}'s account or content. This is a standby role.</p>
<p>${ownerName} can designate up to three Guardians. You are Guardian ${params.order}.</p>
<p><a href="${acceptUrl}">Accept Guardian Role</a></p>
<p>— The Tether Team</p>
</div>`;
  }

  private buildRecipientNotificationHtml(params: {
    recipientName: string;
    ownerName: string;
    signupUrl: string;
  }): string {
    const recipientName = escapeHtml(params.recipientName);
    const ownerName = escapeHtml(params.ownerName);
    const signupUrl = escapeHtml(params.signupUrl);

    return `<div style="font-family:sans-serif;max-width:600px">
<p>Hi ${recipientName},</p>
<p>${ownerName} has designated you as a recipient in their digital legacy plan on Tether. This means they've prepared messages, photos, documents, or memoir chapters specifically for you.</p>
<p><strong>What this means</strong></p>
<p>When the time comes, you'll receive a secure link to access everything ${ownerName} has prepared for you. Until then, no action is needed on your part.</p>
<p>If you'd like to create your own Tether account to start preparing your digital legacy, you can do so at any time:</p>
<p><a href="${signupUrl}">Create Your Own Tether Account</a></p>
<p>— The Tether Team</p>
</div>`;
  }
}
