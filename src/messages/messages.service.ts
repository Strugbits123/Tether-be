import { randomUUID } from 'crypto';
import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Mux from '@mux/mux-node';
import { DeepgramClient } from '@deepgram/sdk';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { AnalyticsService } from '../shared/posthog/analytics.service.js';
import { AssignmentDto } from './dto/assignment.dto.js';
import { CreateTextMessageDto } from './dto/create-text-message.dto.js';
import { CreateVideoMessageDto } from './dto/create-video-message.dto.js';
import { CreateAudioMessageDto } from './dto/create-audio-message.dto.js';
import { ConfirmUploadDto } from './dto/confirm-upload.dto.js';
import { UpdateMessageDto } from './dto/update-message.dto.js';
import { ReorderMessagesDto } from './dto/reorder-messages.dto.js';
import { ActivityService } from '../activity/activity.service.js';

const AUDIO_MIME_TO_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
};

function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const TRANSCRIPTION_TIMEOUT_MS = 120_000;

// Bounds an external call so a hang can't leave a row stuck 'processing'
// forever — the rejection flows into the existing catch → status 'failed'.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
    private readonly analytics: AnalyticsService,
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
    // Authorize recipients before persisting anything, so an invalid recipient
    // returns 403 without leaving an orphaned message row.
    await this.authorizeAssignmentRecipients(userId, dto.assignments);

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
    this.analytics
      .markOnboardingStep(userId, 'create_message')
      .catch(() => null);
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
    // Text is fully saved on creation, so message_saved fires now.
    await this.fireMessageSaved(userId, message.id, 'written', null, {
      char_count: stripHtmlTags(dto.body).length,
    });
    return message;
  }

  // ─── Video message ─────────────────────────────────────────────────────────

  async createVideoUploadUrl(userId: string, dto: CreateVideoMessageDto) {
    // Authorize recipients before creating the Mux upload / message row, so an
    // invalid recipient can't leave orphaned content.
    await this.authorizeAssignmentRecipients(userId, dto.assignments);

    const mux = this.getMuxClient();
    const frontendUrl =
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';

    let upload: Awaited<ReturnType<typeof mux.video.uploads.create>>;
    try {
      upload = await mux.video.uploads.create({
        new_asset_settings: {
          playback_policy: ['signed'],
          encoding_tier: 'baseline',
          // Mux serves no downloadable file unless a static rendition is
          // requested — without this, a video can only ever be streamed. The RM
          // video-download page depends on 'highest.mp4' existing. Assets
          // created before this was added have it enabled lazily on first
          // listing (see RmDownloadsService.listVideos).
          static_renditions: [{ resolution: 'highest' }],
        },
        cors_origin: frontendUrl,
      });
    } catch {
      throw new InternalServerErrorException('Failed to create Mux upload');
    }

    const { data: message, error } = await this.supabase
      .getClient()
      .from('messages')
      .insert({
        user_id: userId,
        type: 'video',
        source: 'browser',
        title: dto.title,
        notes: dto.notes ?? null,
        mux_upload_id: upload.id,
        processing_status: 'uploading',
        transcription_status: 'pending',
        display_order: 0,
      })
      .select()
      .single();

    if (error || !message) {
      throw new InternalServerErrorException('Failed to create message record');
    }

    await this.createAssignments(userId, message.id, dto.assignments);
    this.analytics
      .markOnboardingStep(userId, 'create_message')
      .catch(() => null);
    this.activityService.log(
      userId,
      'message_created',
      `Video message "${dto.title}" started`,
      {
        messageId: message.id,
        type: 'video',
        title: dto.title,
      },
    );
    // message_created for video is emitted from the Mux 'asset.ready' webhook,
    // where the real duration_sec is known.
    return {
      messageId: message.id,
      uploadUrl: upload.url,
      muxUploadId: upload.id,
    };
  }

  // ─── Audio message ─────────────────────────────────────────────────────────

  async createAudioUploadUrl(userId: string, dto: CreateAudioMessageDto) {
    // Authorize recipients before minting the upload URL / message row.
    await this.authorizeAssignmentRecipients(userId, dto.assignments);

    const ext = AUDIO_MIME_TO_EXT[dto.fileType] ?? 'webm';
    const storagePath = `${userId}/${randomUUID()}.${ext}`;

    const { data, error: urlError } = await this.supabase
      .getClient()
      .storage.from('audio')
      .createSignedUploadUrl(storagePath);

    if (urlError) {
      throw new InternalServerErrorException(
        'Failed to generate audio upload URL',
      );
    }

    const { data: message, error } = await this.supabase
      .getClient()
      .from('messages')
      .insert({
        user_id: userId,
        type: 'audio',
        source: 'browser',
        title: dto.title,
        notes: dto.notes ?? null,
        storage_path: storagePath,
        mime_type: dto.fileType,
        processing_status: 'uploading',
        transcription_status: 'pending',
        display_order: 0,
      })
      .select()
      .single();

    if (error || !message) {
      throw new InternalServerErrorException('Failed to create message record');
    }

    await this.createAssignments(userId, message.id, dto.assignments);
    this.analytics
      .markOnboardingStep(userId, 'create_message')
      .catch(() => null);
    this.activityService.log(
      userId,
      'message_created',
      `Audio message "${dto.title}" started`,
      {
        messageId: message.id,
        type: 'audio',
        title: dto.title,
      },
    );
    // message_created for audio is emitted on confirmUpload, where duration_sec
    // and file size are known.
    return {
      messageId: message.id,
      signedUploadUrl: data.signedUrl,
      storagePath,
    };
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

    // Audio is fully saved once the upload is confirmed and duration is known.
    await this.fireMessageSaved(
      userId,
      messageId,
      'audio',
      updated.duration_seconds ?? null,
    );

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

    // Authorize recipients BEFORE any mutation so a cross-tenant recipient
    // can't change title/body/notes and then fail with 403.
    let assignmentRows:
      | { assignment_scope: string; group_value: string | null; recipient_id: string | null }[]
      | null = null;
    if (dto.assignments !== undefined) {
      const effective =
        dto.assignments.length > 0 ? dto.assignments : [{ scope: 'assign_later' }];
      await this.assertRecipientsOwned(
        userId,
        effective
          .filter((a) => a.scope === 'individual' && a.recipientId)
          .map((a) => a.recipientId as string),
      );
      assignmentRows = effective.map((a) => ({
        assignment_scope: a.scope,
        group_value: a.scope === 'group' ? (a.groupValue ?? null) : null,
        recipient_id: a.scope === 'individual' ? (a.recipientId ?? null) : null,
      }));
    }

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

    if (assignmentRows !== null) {
      // Transactional replace: delete + insert in one RPC so a failed insert
      // can't permanently leave the message unassigned.
      const { error: replaceError } = await this.supabase
        .getClient()
        .rpc('replace_content_assignments', {
          p_user_id: userId,
          p_content_type: 'message',
          p_content_id: messageId,
          p_rows: assignmentRows,
        });
      if (replaceError) {
        throw new InternalServerErrorException('Failed to update assignments');
      }
    }

    return updated;
  }

  // ─── Reorder messages ──────────────────────────────────────────────────────

  async reorderMessages(userId: string, dto: ReorderMessagesDto) {
    // One transactional statement scoped to the owner; the RPC rolls back and
    // errors unless every requested id was updated, so a partial reorder can't
    // commit while we report success.
    const { error } = await this.supabase.getClient().rpc('reorder_messages', {
      p_user_id: userId,
      p_order: dto.order.map((item) => ({
        id: item.messageId,
        display_order: item.displayOrder,
      })),
    });

    if (error) {
      throw new InternalServerErrorException('Failed to reorder messages');
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

    this.posthog.capture(userId, 'message_deleted', {
      message_type: this.analyticsType(message.type as string),
      age_days: this.ageDays(message.created_at as string | null),
    });

    return { message: 'Message deleted' };
  }

  // ─── Mux webhook handlers ──────────────────────────────────────────────────

  async handleMuxAssetReady(event: Record<string, unknown>) {
    const data = event.data as Record<string, unknown>;
    const assetId = data.id as string;
    const playbackIds = data.playback_ids as Array<{ id: string }> | undefined;
    const playbackId = playbackIds?.[0]?.id ?? null;
    const uploadId = data.upload_id as string;

    // Transition to 'ready' only if not already ready, and gate all follow-up
    // work on that one-time transition. A duplicate video.asset.ready delivery
    // updates zero rows here, so analytics can't double-count and transcription
    // isn't retriggered.
    const { data: transitioned } = await this.supabase
      .getClient()
      .from('messages')
      .update({
        mux_asset_id: assetId,
        mux_playback_id: playbackId,
        processing_status: 'ready',
        duration_seconds: Math.round((data.duration as number) ?? 0),
        updated_at: new Date().toISOString(),
      })
      .eq('mux_upload_id', uploadId)
      .neq('processing_status', 'ready')
      .select('id, user_id')
      .maybeSingle();

    if (!transitioned) return; // unknown upload, or already-ready duplicate

    if (playbackId) {
      this.transcribeVideo(transitioned.id, playbackId).catch(() => null);
    }

    // Video is fully saved once Mux finishes processing the asset.
    await this.fireMessageSaved(
      transitioned.user_id,
      transitioned.id,
      'video',
      Math.round((data.duration as number) ?? 0),
    );
  }

  /**
   * Caches the state of an asset's downloadable MP4 from the
   * video.asset.static_rendition.* webhooks, so RmDownloadsService.listVideos can
   * answer from the database instead of calling Mux once per video per page load.
   *
   * Only the 'highest' rendition matters — that's the one the download page
   * serves and the only one we request. Other resolutions are ignored so a
   * future additional rendition can't overwrite this state.
   */
  async handleMuxStaticRenditionEvent(
    event: Record<string, unknown>,
    status: 'preparing' | 'ready' | 'errored' | 'skipped',
  ) {
    const data = (event.data ?? {}) as Record<string, unknown>;

    // For static-rendition events the parent asset arrives as data.asset_id;
    // `object` carries it too. Read both — the payload shape has moved before.
    const object = (event.object ?? {}) as Record<string, unknown>;
    const assetId =
      (data.asset_id as string | undefined) ??
      (object.type === 'asset' ? (object.id as string | undefined) : undefined);

    if (!assetId) {
      this.logger.warn(
        `Mux static rendition event '${event.type as string}' had no resolvable asset id`,
      );
      return;
    }

    const name = data.name as string | undefined;
    const resolution = data.resolution as string | undefined;
    if (name && name !== 'highest.mp4' && resolution !== 'highest') {
      return; // a rendition we don't serve
    }

    // filesize is a string in the Mux payload.
    const rawSize = data.filesize as string | number | undefined;
    const bytes =
      status === 'ready' && rawSize !== undefined && rawSize !== null
        ? Number(rawSize)
        : null;

    const { error } = await this.supabase
      .getClient()
      .from('messages')
      .update({
        mux_static_rendition_status: status,
        ...(bytes !== null && Number.isFinite(bytes)
          ? { mux_static_rendition_bytes: bytes }
          : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('mux_asset_id', assetId);

    if (error) {
      // Not fatal: listVideos still falls back to querying Mux directly when the
      // cached state is missing or stale.
      this.logger.error(
        `Failed to cache static rendition status '${status}' for asset ${assetId}`,
        error,
      );
    }
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
      const response = await withTimeout(
        client.listen.v1.media.transcribeUrl({
          url: muxPlaybackUrl,
          model: 'nova-2',
          smart_format: true,
        }),
        TRANSCRIPTION_TIMEOUT_MS,
        'Deepgram video transcription',
      );
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
      const response = await withTimeout(
        client.listen.v1.media.transcribeUrl({
          url: urlData.signedUrl,
          model: 'nova-2',
          smart_format: true,
        }),
        TRANSCRIPTION_TIMEOUT_MS,
        'Deepgram audio transcription',
      );
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

    // Cross-tenant guard: individual recipients must belong to this user.
    await this.assertRecipientsOwned(
      userId,
      effective
        .filter((a) => a.scope === 'individual' && a.recipientId)
        .map((a) => a.recipientId as string),
    );

    // Single batched insert instead of one round trip per assignment.
    const rows = effective.map((a) => ({
      user_id: userId,
      content_type: 'message',
      content_id: messageId,
      assignment_scope: a.scope,
      group_value: a.scope === 'group' ? (a.groupValue ?? null) : null,
      recipient_id: a.scope === 'individual' ? (a.recipientId ?? null) : null,
    }));

    const { error } = await this.supabase
      .getClient()
      .from('content_assignments')
      .insert(rows);

    if (error) {
      throw new InternalServerErrorException('Failed to create assignment');
    }

    // Fire message_assigned only when the user actually assigned recipients
    // (not the implicit 'assign_later' default). recipient_count reflects the
    // number of individually-named recipients.
    const hasExplicitAssignment = assignments.some(
      (a) => a.scope !== 'assign_later',
    );
    if (hasExplicitAssignment) {
      this.posthog.capture(userId, 'message_assigned', {
        recipient_count: assignments.filter((a) => a.scope === 'individual')
          .length,
      });
    }
  }

  // Authorize the individual recipients referenced by an assignment list.
  private async authorizeAssignmentRecipients(
    userId: string,
    assignments: AssignmentDto[],
  ) {
    await this.assertRecipientsOwned(
      userId,
      assignments
        .filter((a) => a.scope === 'individual' && a.recipientId)
        .map((a) => a.recipientId as string),
    );
  }

  private async assertRecipientsOwned(userId: string, recipientIds: string[]) {
    const unique = [...new Set(recipientIds)];
    if (unique.length === 0) return;
    const { data, error } = await this.supabase
      .getClient()
      .from('recipients')
      .select('id')
      .eq('user_id', userId)
      .in('id', unique);
    // Surface a real query failure as 500 instead of masking it as "not owned".
    if (error) {
      throw new InternalServerErrorException('Failed to verify recipients');
    }
    if ((data?.length ?? 0) !== unique.length) {
      throw new ForbiddenException(
        'One or more recipients do not belong to this account',
      );
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

  // Maps the stored message type ('text'|'audio'|'video') to the tracking-plan
  // vocabulary ('written'|'audio'|'video') so recorder and message events share
  // one message_type value space.
  private analyticsType(dbType: string): string {
    return dbType === 'text' ? 'written' : dbType;
  }

  private ageDays(createdAt: string | null): number | null {
    if (!createdAt) return null;
    const created = new Date(createdAt).getTime();
    if (Number.isNaN(created)) return null;
    return Math.max(0, Math.floor((Date.now() - created) / 86_400_000));
  }

  // Fires message_saved (with recipient_count derived from the message's
  // individual assignments) and, when it's the account's only message so far,
  // first_message_recorded.
  private async fireMessageSaved(
    userId: string,
    messageId: string,
    messageType: string,
    durationSeconds: number | null,
    extra?: Record<string, any>,
  ) {
    const { count: recipientCount } = await this.supabase
      .getClient()
      .from('content_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('content_type', 'message')
      .eq('content_id', messageId)
      .eq('assignment_scope', 'individual');

    this.posthog.capture(userId, 'message_saved', {
      message_type: messageType,
      duration_seconds: durationSeconds,
      recipient_count: recipientCount ?? 0,
      // Scheduled delivery is not part of this backend subset yet.
      has_scheduled_date: false,
      ...extra,
    });

    await this.maybeFireFirstMessage(userId, messageType);
  }

  private async maybeFireFirstMessage(userId: string, messageType: string) {
    const { count } = await this.supabase
      .getClient()
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    if ((count ?? 0) !== 1) return;

    const { data: user } = await this.supabase
      .getClient()
      .from('users')
      .select('created_at')
      .eq('id', userId)
      .single();

    this.posthog.capture(userId, 'first_message_recorded', {
      days_since_signup: this.ageDays(
        (user?.created_at as string | null) ?? null,
      ),
      message_type: messageType,
    });
  }
}
