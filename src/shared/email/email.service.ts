import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

// Deliberately not delegated to a general-purpose HTML sanitizer: several
// escaped values here (acceptUrl, cancelUrl, portalUrl) are interpolated
// inside href="..." attributes, so quote characters must be entity-encoded
// too — sanitize-html's tag/attribute-filtering model doesn't guarantee that
// for plain text nodes the way this explicit encoding does.
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

  async sendReleaseNotificationToOwner(params: {
    to: string;
    ownerName: string;
    rmName: string;
    reason: string;
    deliveryDate: string;
    cancelUrl: string;
    planId: string;
  }): Promise<string | null> {
    const ownerName = escapeHtml(params.ownerName);
    const rmName = escapeHtml(params.rmName);
    const reason = escapeHtml(params.reason);
    const deliveryDate = escapeHtml(params.deliveryDate);
    const cancelUrl = escapeHtml(params.cancelUrl);
    return this.send({
      to: params.to,
      subject: `⚠️ Release Plan ${params.planId} initiated for your Tether account`,
      html: `<div style="font-family:sans-serif;max-width:600px">
<p>Hi ${ownerName},</p>
<p>Your Release Manager, ${rmName}, has initiated the release of your Tether content.</p>
<p><strong>Reason:</strong> ${reason}<br/><strong>Delivery scheduled:</strong> ${deliveryDate}</p>
<p>If this was done in error, you can cancel the release:</p>
<p><a href="${cancelUrl}">Cancel Release</a></p>
<p>This link expires on ${deliveryDate}. After that, content is delivered automatically and cannot be recalled.</p>
<p>— The Tether Team</p>
</div>`,
    });
  }

  async sendReleaseNotificationToRecipient(params: {
    to: string;
    recipientName: string;
    ownerName: string;
    deliveryDate: string;
  }): Promise<string | null> {
    const recipientName = escapeHtml(params.recipientName);
    const ownerName = escapeHtml(params.ownerName);
    const deliveryDate = escapeHtml(params.deliveryDate);
    return this.send({
      to: params.to,
      subject: `${params.ownerName} has left something for you`,
      html: `<div style="font-family:sans-serif;max-width:600px">
<p>Hi ${recipientName},</p>
<p>${ownerName} prepared messages, photos, and memories for you through Tether — a digital legacy platform.</p>
<p>Their content is being securely prepared for delivery. You will receive a link to access your personal portal on ${deliveryDate}.</p>
<p>No action is needed right now.</p>
<p>— The Tether Team</p>
</div>`,
    });
  }

  async sendDeliveryEmail(params: {
    to: string;
    recipientName: string;
    ownerName: string;
    portalUrl: string;
  }): Promise<string | null> {
    const recipientName = escapeHtml(params.recipientName);
    const ownerName = escapeHtml(params.ownerName);
    const portalUrl = escapeHtml(params.portalUrl);
    return this.send({
      to: params.to,
      subject: `${params.ownerName}'s legacy is ready for you`,
      html: `<div style="font-family:sans-serif;max-width:600px">
<p>Hi ${recipientName},</p>
<p>${ownerName} prepared personal content just for you. It's now ready to view in your private Tether portal.</p>
<p><a href="${portalUrl}">Access Your Portal</a></p>
<p>This portal contains messages, photos, documents, and memoir chapters that ${ownerName} chose specifically for you.</p>
<p>— The Tether Team</p>
</div>`,
    });
  }

  async sendGuardianEscalation(params: {
    to: string;
    guardianName: string;
    ownerName: string;
    rmName: string;
    explanation: string;
    acceptUrl: string;
  }): Promise<string | null> {
    const guardianName = escapeHtml(params.guardianName);
    const ownerName = escapeHtml(params.ownerName);
    const rmName = escapeHtml(params.rmName);
    const explanation = escapeHtml(params.explanation);
    const acceptUrl = escapeHtml(params.acceptUrl);
    return this.send({
      to: params.to,
      subject: `Action needed: ${params.ownerName}'s Release Manager needs your help`,
      html: `<div style="font-family:sans-serif;max-width:600px">
<p>Hi ${guardianName},</p>
<p>${rmName}, the Release Manager for ${ownerName}'s Tether account, has requested that you step in to complete the release process.</p>
<p>Their message: "${explanation}"</p>
<p>As ${ownerName}'s Guardian, you can accept this responsibility and manage the content delivery.</p>
<p><a href="${acceptUrl}">Accept &amp; Start Release</a></p>
<p>If you don't respond within 3 days, the next Guardian will be contacted.</p>
<p>— The Tether Team</p>
</div>`,
    });
  }

  async sendReleaseCancelledNotification(params: {
    to: string;
    name: string;
    ownerName: string;
    reason: string;
  }): Promise<string | null> {
    const name = escapeHtml(params.name);
    const ownerName = escapeHtml(params.ownerName);
    const reason = escapeHtml(params.reason);
    return this.send({
      to: params.to,
      subject: `${params.ownerName}'s Release Plan was cancelled`,
      html: `<div style="font-family:sans-serif;max-width:600px">
<p>Hi ${name},</p>
<p>The Release Plan for ${ownerName}'s Tether account has been cancelled.</p>
<p><strong>Reason:</strong> ${reason}</p>
<p>No content will be delivered at this time.</p>
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

    // Bounds a stalled network call so callers awaiting this directly (e.g.
    // signup, invitation flows) can't hang indefinitely on a slow Resend request.
    const SEND_TIMEOUT_MS = 15000;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('Resend send timed out')),
        SEND_TIMEOUT_MS,
      );
    });

    const sendPromise = this.resend.emails.send({
      from: this.config.get<string>('RESEND_FROM_ADDRESS') ?? 'Tether <no-reply@jointether.com>',
      to: [params.to],
      subject: params.subject,
      html: params.html,
    });

    // Promise.race doesn't cancel the loser. If the timeout wins, this promise
    // is still in flight and would raise an unhandled rejection when it later
    // fails, so attach a no-op catch up front.
    sendPromise.catch(() => undefined);

    try {
      const { data, error } = await Promise.race([sendPromise, timeout]);

      if (error) {
        throw new Error(`Resend send failed: ${error.message ?? 'unknown error'}`);
      }

      return data?.id ?? null;
    } finally {
      // Otherwise a successful send leaves the timer pending for the full 15s.
      clearTimeout(timeoutHandle);
    }
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
