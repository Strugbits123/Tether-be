import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Mux from '@mux/mux-node';
import { DeepgramClient } from '@deepgram/sdk';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { AssignmentDto } from './dto/assignment.dto.js';
import { CreateTextMessageDto } from './dto/create-text-message.dto.js';
import { ConfirmUploadDto } from './dto/confirm-upload.dto.js';
import { UpdateMessageDto } from './dto/update-message.dto.js';
import { ReorderMessagesDto } from './dto/reorder-messages.dto.js';
import { ActivityService } from '../activity/activity.service.js';

function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
  ) {}

  private getMuxClient(): Mux {
    const tokenId = this.config.get<string>('MUX_TOKEN_ID');
    const tokenSecret = this.config.get<string>('MUX_TOKEN_SECRET');
    if (!tokenId || !tokenSecret) {
      throw new ServiceUnavailableException('Video service not configured');
    }
    const signingKey = this.config.get<string>('MUX_SIGNING_KEY');
    const privateKey = this.config.get<string>('MUX_PRIVATE_KEY');
    return new Mux({
      tokenId,
      tokenSecret,
      ...(signingKey && { jwtSigningKey: signingKey }),
      ...(privateKey && { jwtPrivateKey: privateKey }),
    });
  }

  // ─── Text message ──────────────────────────────────────────────────────────

  async createTextMessage(userId: string, dto: CreateTextMessageDto) {
    const { data: message, error } = await this.supabase
      .getClient()
      .from('messages')
      .insert({
        user_id: userId,
        type: 'text',
        source: 'browser',
        title: dto.title,
        body: dto.body,
        notes: dto.notes ?? null,
        processing_status: 'ready',
        transcription_status: 'completed',
        transcript: stripHtmlTags(dto.body),
        display_order: 0,
      })
      .select()
      .single();

    if (error || !message) {
      throw new InternalServerErrorException('Failed to create message');
    }

    await this.createAssignments(userId, message.id, dto.assignments);
    this.markOnboardingCreateMessage(userId).catch(() => null);
    this.activityService.log(
      userId,
      'message_created',
      `"${dto.title}" written`,
      {
        messageId: message.id,
        type: 'text',
        title: dto.title,
      },
    );
    this.posthog.capture(userId, 'server_message_created', { type: 'text', title: dto.title });
    return message;
  }

  // ─── Confirm audio upload ──────────────────────────────────────────────────

  async confirmUpload(
    userId: string,
    messageId: string,
    dto: ConfirmUploadDto,
  ) {
    const message = await this.requireOwnedMessage(userId, messageId);

    if (message.type !== 'audio' || message.processing_status !== 'uploading') {
      throw new ForbiddenException('Message is not awaiting audio upload');
    }

    const { data: updated, error } = await this.supabase
      .getClient()
      .from('messages')
      .update({
        processing_status: 'ready',
        // 0 means the browser couldn't measure duration; store NULL to satisfy
        // the messages_duration_seconds_check constraint (which rejects 0).
        duration_seconds: dto.durationSeconds || null,
        file_size_bytes: dto.fileSizeBytes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', messageId)
      .select()
      .single();

    if (error || !updated) {
      throw new InternalServerErrorException('Failed to confirm upload');
    }

    this.transcribeAudio(messageId, message.storage_path).catch(() => null);
    return updated;
  }

  // ─── List messages ─────────────────────────────────────────────────────────

  async listMessages(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('messages')
      .select(
        'id, user_id, type, title, notes, body, processing_status, transcription_status, transcript, duration_seconds, file_size_bytes, display_order, created_at, updated_at',
      )
      .eq('user_id', userId)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch messages');
    }

    return data ?? [];
  }

  // ─── Single message ────────────────────────────────────────────────────────

  async getMessage(userId: string, messageId: string) {
    const message = await this.requireOwnedMessage(userId, messageId);
    const withAudio = await this.attachAudioUrl(message, 3600);
    const assignments = await this.fetchAssignments(messageId);
    return { ...withAudio, assignments };
  }

  // ─── Status polling ────────────────────────────────────────────────────────

  async getMessageStatus(userId: string, messageId: string) {
    const message = await this.requireOwnedMessage(userId, messageId);
    return {
      processingStatus: message.processing_status,
      transcriptionStatus: message.transcription_status,
      ...(message.transcription_status === 'completed' && {
        transcript: message.transcript,
      }),
    };
  }

  // ─── Mux playback token ────────────────────────────────────────────────────

  async getMuxPlaybackToken(userId: string, messageId: string) {
    const message = await this.requireOwnedMessage(userId, messageId);

    if (message.type !== 'video' || !message.mux_playback_id) {
      throw new ForbiddenException('Message has no Mux playback ID');
    }

    const signingKey = this.config.get<string>('MUX_SIGNING_KEY');
    const privateKey = this.config.get<string>('MUX_PRIVATE_KEY');
    if (!signingKey || !privateKey) {
      throw new ServiceUnavailableException(
        'Video playback signing not configured',
      );
    }

    const mux = this.getMuxClient();
    let token: string;
    try {
      token = await mux.jwt.signPlaybackId(message.mux_playback_id, {
        type: 'video',
        expiration: '1h',
      });
    } catch {
      throw new InternalServerErrorException(
        'Failed to generate playback token',
      );
    }

    return { token, playbackId: message.mux_playback_id };
  }

  // ─── Audio signed URL ──────────────────────────────────────────────────────

  async getAudioSignedUrl(userId: string, messageId: string) {
    const message = await this.requireOwnedMessage(userId, messageId);

    if (message.type !== 'audio' || !message.storage_path) {
      throw new ForbiddenException('Message has no audio storage path');
    }

    const { data, error } = await this.supabase
      .getClient()
      .storage.from('audio')
      .createSignedUrl(message.storage_path, 900);

    if (error || !data) {
      throw new InternalServerErrorException('Failed to generate audio URL');
    }

    return { signedUrl: data.signedUrl, expiresIn: 900 };
  }

  // ─── Update message ────────────────────────────────────────────────────────

  async updateMessage(
    userId: string,
    messageId: string,
    dto: UpdateMessageDto,
  ) {
    await this.requireOwnedMessage(userId, messageId);

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (dto.title !== undefined) updates.title = dto.title;
    if (dto.body !== undefined) {
      updates.body = dto.body;
      updates.transcript = stripHtmlTags(dto.body);
    }
    if (dto.notes !== undefined) updates.notes = dto.notes;

    const { data: updated, error } = await this.supabase
      .getClient()
      .from('messages')
      .update(updates)
      .eq('id', messageId)
      .select()
      .single();

    if (error || !updated) {
      throw new InternalServerErrorException('Failed to update message');
    }

    if (dto.assignments !== undefined) {
      await this.supabase
        .getClient()
        .from('content_assignments')
        .delete()
        .eq('content_type', 'message')
        .eq('content_id', messageId);

      await this.createAssignments(userId, messageId, dto.assignments);
    }

    return updated;
  }

  // ─── Reorder messages ──────────────────────────────────────────────────────

  async reorderMessages(userId: string, dto: ReorderMessagesDto) {
    for (const item of dto.order) {
      await this.supabase
        .getClient()
        .from('messages')
        .update({ display_order: item.displayOrder })
        .eq('id', item.messageId)
        .eq('user_id', userId);
    }
    return { message: 'Messages reordered' };
  }

  // ─── Delete message ────────────────────────────────────────────────────────

  async deleteMessage(userId: string, messageId: string) {
    const message = await this.requireOwnedMessage(userId, messageId);

    if (message.type === 'video' && message.mux_asset_id) {
      try {
        const mux = this.getMuxClient();
        await mux.video.assets.delete(message.mux_asset_id);
      } catch {
        // non-fatal: asset already deleted or Mux unreachable
      }
    }

    if (message.type === 'audio' && message.storage_path) {
      await this.supabase
        .getClient()
        .storage.from('audio')
        .remove([message.storage_path]);
    }

    const { error } = await this.supabase
      .getClient()
      .from('messages')
      .delete()
      .eq('id', messageId);

    if (error) {
      throw new InternalServerErrorException('Failed to delete message');
    }

    return { message: 'Message deleted' };
  }

  // ─── Mux webhook handlers ──────────────────────────────────────────────────

  async handleMuxAssetReady(event: Record<string, unknown>) {
    const data = event.data as Record<string, unknown>;
    const assetId = data.id as string;
    const playbackIds = data.playback_ids as Array<{ id: string }> | undefined;
    const playbackId = playbackIds?.[0]?.id ?? null;
    const uploadId = data.upload_id as string;

    const { data: message } = await this.supabase
      .getClient()
      .from('messages')
      .select('id, user_id')
      .eq('mux_upload_id', uploadId)
      .single();

    if (!message) return;

    await this.supabase
      .getClient()
      .from('messages')
      .update({
        mux_asset_id: assetId,
        mux_playback_id: playbackId,
        processing_status: 'ready',
        duration_seconds: Math.round((data.duration as number) ?? 0),
        updated_at: new Date().toISOString(),
      })
      .eq('id', message.id);

    if (playbackId) {
      this.transcribeVideo(message.id, playbackId).catch(() => null);
    }

    this.posthog.capture(message.user_id, 'server_video_processed', {
      messageId: message.id,
      duration_seconds: Math.round((event.data as Record<string, unknown>).duration as number ?? 0),
    });
  }

  async handleMuxAssetErrored(event: Record<string, unknown>) {
    const data = event.data as Record<string, unknown>;
    const uploadId = data.upload_id as string;

    await this.supabase
      .getClient()
      .from('messages')
      .update({
        processing_status: 'failed',
        transcription_status: 'failed',
        updated_at: new Date().toISOString(),
      })
      .eq('mux_upload_id', uploadId);
  }

  // ─── Transcription ─────────────────────────────────────────────────────────

  async transcribeVideo(messageId: string, playbackId: string): Promise<void> {
    const apiKey = this.config.get<string>('DEEPGRAM_API_KEY');
    if (!apiKey) {
      await this.setTranscriptionFailed(messageId);
      return;
    }

    // Assets use signed playback policy — generate a short-lived JWT for Deepgram.
    const signingKey = this.config.get<string>('MUX_SIGNING_KEY');
    const privateKey = this.config.get<string>('MUX_PRIVATE_KEY');
    if (!signingKey || !privateKey) {
      await this.setTranscriptionFailed(messageId);
      return;
    }

    let muxPlaybackUrl: string;
    try {
      const mux = this.getMuxClient();
      const jwtToken = await mux.jwt.signPlaybackId(playbackId, {
        type: 'video',
        expiration: '1h',
      });
      muxPlaybackUrl = `https://stream.mux.com/${playbackId}.m3u8?token=${jwtToken}`;
    } catch {
      await this.setTranscriptionFailed(messageId);
      return;
    }

    try {
      const client = new DeepgramClient({ apiKey });
      const response = await client.listen.v1.media.transcribeUrl({
        url: muxPlaybackUrl,
        model: 'nova-2',
        smart_format: true,
      });
      const r = response as unknown as {
        results?: {
          channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
        };
      };
      const transcript =
        r?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? null;

      await this.supabase
        .getClient()
        .from('messages')
        .update({
          transcript,
          transcription_status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', messageId);
    } catch {
      await this.setTranscriptionFailed(messageId);
    }
  }

  async transcribeAudio(messageId: string, storagePath: string): Promise<void> {
    const apiKey = this.config.get<string>('DEEPGRAM_API_KEY');
    if (!apiKey) {
      await this.setTranscriptionFailed(messageId);
      return;
    }

    const { data: urlData } = await this.supabase
      .getClient()
      .storage.from('audio')
      .createSignedUrl(storagePath, 3600);

    if (!urlData?.signedUrl) {
      await this.setTranscriptionFailed(messageId);
      return;
    }

    try {
      const client = new DeepgramClient({ apiKey });
      const response = await client.listen.v1.media.transcribeUrl({
        url: urlData.signedUrl,
        model: 'nova-2',
        smart_format: true,
      });
      const r = response as unknown as {
        results?: {
          channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
        };
      };
      const transcript =
        r?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? null;

      await this.supabase
        .getClient()
        .from('messages')
        .update({
          transcript,
          transcription_status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', messageId);
    } catch {
      await this.setTranscriptionFailed(messageId);
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async fetchAssignments(messageId: string) {
    const { data } = await this.supabase
      .getClient()
      .from('content_assignments')
      .select('id, assignment_scope, group_value, recipient_id')
      .eq('content_type', 'message')
      .eq('content_id', messageId);
    return data ?? [];
  }

  private async requireOwnedMessage(userId: string, messageId: string) {
    const { data: message, error } = await this.supabase
      .getClient()
      .from('messages')
      .select('*')
      .eq('id', messageId)
      .eq('user_id', userId)
      .single();

    if (error || !message) throw new NotFoundException('Message not found');
    return message;
  }

  private async createAssignments(
    userId: string,
    messageId: string,
    assignments: AssignmentDto[],
  ) {
    const effective =
      assignments.length > 0 ? assignments : [{ scope: 'assign_later' }];

    for (const a of effective) {
      const { error } = await this.supabase
        .getClient()
        .from('content_assignments')
        .insert({
          user_id: userId,
          content_type: 'message',
          content_id: messageId,
          assignment_scope: a.scope,
          group_value: a.scope === 'group' ? (a.groupValue ?? null) : null,
          recipient_id:
            a.scope === 'individual' ? (a.recipientId ?? null) : null,
        });

      if (error) {
        throw new InternalServerErrorException('Failed to create assignment');
      }
    }
  }

  private async attachAudioUrl(message: Record<string, unknown>, ttl: number) {
    if (message.type === 'audio' && message.storage_path) {
      const { data } = await this.supabase
        .getClient()
        .storage.from('audio')
        .createSignedUrl(message.storage_path as string, ttl);
      return { ...message, audioSignedUrl: data?.signedUrl ?? null };
    }
    return message;
  }

  private async setTranscriptionFailed(messageId: string) {
    await this.supabase
      .getClient()
      .from('messages')
      .update({
        transcription_status: 'failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', messageId);
  }

  private async markOnboardingCreateMessage(userId: string) {
    const { data } = await this.supabase
      .getClient()
      .from('users')
      .select('onboarding')
      .eq('id', userId)
      .single();

    if (!data) return;

    const onboarding = (data.onboarding ?? {}) as Record<string, unknown>;
    onboarding['create_message'] = true;

    const steps = [
      'finish_account',
      'add_release_manager',
      'add_recipients',
      'add_photos',
      'create_message',
    ];
    if (steps.every((s) => onboarding[s] === true)) {
      onboarding['completed_at'] = new Date().toISOString();
    }

    await this.supabase
      .getClient()
      .from('users')
      .update({ onboarding, updated_at: new Date().toISOString() })
      .eq('id', userId);
  }
}
