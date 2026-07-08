import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sanitizeHtml from 'sanitize-html';
import { DeepgramClient } from '@deepgram/sdk';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { RecipientsService } from '../recipients/recipients.service.js';
import { CreateChapterDto } from './dto/create-chapter.dto.js';
import { UpdateChapterDto } from './dto/update-chapter.dto.js';
import { AutosaveChapterDto } from './dto/autosave-chapter.dto.js';
import { ReorderChaptersDto } from './dto/reorder-chapters.dto.js';
import { RequestExhibitUploadUrlDto } from './dto/request-exhibit-upload-url.dto.js';
import { CreateExhibitDto } from './dto/create-exhibit.dto.js';
import { ChapterAssignmentDto } from './dto/assignment.dto.js';
import { SetChapterAssignmentsDto } from './dto/set-chapter-assignments.dto.js';
import {
  CreateVoiceChapterDto,
  RequestVoiceUploadUrlDto,
} from './dto/create-voice-chapter.dto.js';

const CHAPTER_LIST_COLUMNS =
  'id, title, date_label, theme, type, status, word_count, display_order, created_at, updated_at';

const CHAPTER_DETAIL_COLUMNS =
  'id, title, date_label, theme, type, status, word_count, display_order, body, recipient_note, audio_storage_path, audio_duration_seconds, audio_file_size_bytes, audio_mime_type, transcription_status, created_at, updated_at';

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  // Includes inline formatting produced by the rich-text editor: bold (b/strong),
  // italic (i/em), underline, strikethrough, and font colour (span[style] or the
  // legacy <font color>). Without these the editor's styling is stripped on save
  // and never reaches the preview.
  allowedTags: [
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'span',
    'font',
    'ul',
    'ol',
    'li',
    'a',
    'blockquote',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    font: ['color', 'face', 'size'],
    '*': ['style'],
  },
  allowedStyles: {
    '*': {
      color: [/.*/],
      'background-color': [/.*/],
      'font-weight': [/.*/],
      'font-style': [/.*/],
      'text-decoration': [/.*/],
      'text-align': [/^(left|right|center|justify)$/],
    },
  },
};

// Reduce an arbitrary client-supplied file name to a safe basename — strips any
// path components (../, absolute paths) and unsafe characters.
function sanitizeFileName(name: string): string {
  const base = name.replace(/^.*[\\/]/, '');
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '.');
  return cleaned.slice(0, 200) || 'file';
}

const TRANSCRIPTION_TIMEOUT_MS = 120_000;

// Bounds an external call so a hang can't leave a chapter stuck 'processing'
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
export class ChaptersService {
  private readonly logger = new Logger(ChaptersService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
    private readonly recipientsService: RecipientsService,
    private readonly config: ConfigService,
  ) {}

  async createChapter(userId: string, dto: CreateChapterDto) {
    // display_order is computed and inserted atomically in one RPC so
    // concurrent creates can't persist duplicate orders (see db/atomic-functions.sql).
    const { data, error } = await this.supabase
      .getClient()
      .rpc('insert_chapter_ordered', {
        p_user_id: userId,
        p_data: {
          title: dto.title,
          date_label: dto.date_label ?? null,
          theme: dto.theme ?? null,
          type: 'text',
          status: 'draft',
        },
      })
      .single();

    const created = data as Record<string, any> | null;
    if (error || !created) {
      throw new InternalServerErrorException('Failed to create chapter');
    }

    this.activityService
      .log(userId, 'chapter_created', 'Created a new chapter', {
        chapterId: created.id,
        title: created.title,
      })
      .catch(() => null);

    this.posthog.capture(userId, 'chapter_created', {
      chapterId: created.id,
      theme: created.theme,
      type: created.type,
    });

    return created;
  }

  async listChapters(userId: string) {
    const { data: chapters, error } = await this.supabase
      .getClient()
      .from('chapters')
      .select(CHAPTER_LIST_COLUMNS)
      .eq('user_id', userId)
      .order('display_order', { ascending: true });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch chapters');
    }

    const rows = chapters ?? [];
    if (rows.length === 0) {
      return {
        chapters: [],
        stats: {
          total_chapters: 0,
          completed_chapters: 0,
          total_words: 0,
          recipients_assigned: 0,
        },
      };
    }

    const chapterIds = rows.map((c) => c.id);

    const { data: exhibitRows } = await this.supabase
      .getClient()
      .from('chapter_exhibits')
      .select('chapter_id')
      .in('chapter_id', chapterIds);

    const exhibitCounts = new Map<string, number>();
    for (const e of exhibitRows ?? []) {
      exhibitCounts.set(
        e.chapter_id,
        (exhibitCounts.get(e.chapter_id) ?? 0) + 1,
      );
    }

    const { assignmentsByChapter, recipientIds } =
      await this.fetchAssignments(chapterIds);
    const recipientMap = await this.resolveRecipientNames(userId, recipientIds);

    const allRecipientIds = new Set<string>();
    for (const list of assignmentsByChapter.values()) {
      for (const a of list) {
        if (a.assignment_scope === 'individual' && a.recipient_id) {
          allRecipientIds.add(a.recipient_id as string);
        }
      }
    }

    const result = rows.map((chapter) => ({
      ...chapter,
      exhibit_count: exhibitCounts.get(chapter.id) ?? 0,
      assignments: (assignmentsByChapter.get(chapter.id) ?? []).map((a) =>
        this.withRecipientName(a, recipientMap),
      ),
    }));

    const stats = {
      total_chapters: rows.length,
      completed_chapters: rows.filter((c) => c.status === 'complete').length,
      total_words: rows.reduce((sum, c) => sum + (c.word_count ?? 0), 0),
      recipients_assigned: allRecipientIds.size,
    };

    return { chapters: result, stats };
  }

  async getChapter(userId: string, chapterId: string) {
    const { data: chapter, error } = await this.supabase
      .getClient()
      .from('chapters')
      .select(CHAPTER_DETAIL_COLUMNS)
      .eq('id', chapterId)
      .eq('user_id', userId)
      .single();

    if (error || !chapter) throw new NotFoundException('Chapter not found');

    const { data: exhibitRows, error: exhibitError } = await this.supabase
      .getClient()
      .from('chapter_exhibits')
      .select('*')
      .eq('chapter_id', chapterId)
      .order('display_order', { ascending: true });

    if (exhibitError) {
      throw new InternalServerErrorException('Failed to fetch exhibits');
    }

    const exhibits = await this.attachSignedUrls(exhibitRows ?? []);

    const { assignmentsByChapter, recipientIds } = await this.fetchAssignments(
      [chapterId],
      true,
    );
    const recipientMap = await this.resolveRecipientNames(userId, recipientIds);
    const assignments = (assignmentsByChapter.get(chapterId) ?? []).map((a) =>
      this.withRecipientName(a, recipientMap),
    );

    let audio_playback_url: string | null = null;
    if (chapter.type === 'voice' && chapter.audio_storage_path) {
      const { data: urlData } = await this.supabase
        .getClient()
        .storage.from('audio')
        .createSignedUrl(chapter.audio_storage_path as string, 3600);
      audio_playback_url = urlData?.signedUrl ?? null;
    }

    return {
      ...chapter,
      audio_playback_url,
      exhibits,
      assignments,
      assignment_count: assignments.length,
    };
  }

  async updateChapter(
    userId: string,
    chapterId: string,
    dto: UpdateChapterDto,
  ) {
    const chapter = await this.requireOwnedChapter(userId, chapterId);

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    const fieldsUpdated: string[] = [];

    if (dto.title !== undefined) {
      updates.title = dto.title;
      fieldsUpdated.push('title');
    }
    if (dto.date_label !== undefined) {
      updates.date_label = dto.date_label;
      fieldsUpdated.push('date_label');
    }
    if (dto.theme !== undefined) {
      updates.theme = dto.theme;
      fieldsUpdated.push('theme');
    }
    if (dto.body !== undefined) {
      updates.body = sanitizeHtml(dto.body, SANITIZE_OPTIONS);
      fieldsUpdated.push('body');
    }
    if (dto.word_count !== undefined) {
      updates.word_count = dto.word_count;
      fieldsUpdated.push('word_count');
    }
    if (dto.status !== undefined) {
      const nextBody =
        dto.body !== undefined ? (updates.body as string) : chapter.body;
      if (
        dto.status === 'complete' &&
        chapter.status === 'draft' &&
        !this.hasContent(nextBody)
      ) {
        throw new BadRequestException(
          'Cannot mark an empty chapter as complete',
        );
      }
      updates.status = dto.status;
      fieldsUpdated.push('status');
    }

    const { data: updated, error } = await this.supabase
      .getClient()
      .from('chapters')
      .update(updates)
      .eq('id', chapterId)
      .select(CHAPTER_LIST_COLUMNS)
      .single();

    if (error || !updated) {
      throw new InternalServerErrorException('Failed to update chapter');
    }

    if (dto.status !== undefined && dto.status !== chapter.status) {
      this.activityService
        .log(
          userId,
          'chapter_status_changed',
          `Marked chapter as ${dto.status}`,
          { chapterId, oldStatus: chapter.status, newStatus: dto.status },
        )
        .catch(() => null);
    }
    if (dto.title !== undefined && dto.title !== chapter.title) {
      this.activityService
        .log(userId, 'chapter_updated', 'Updated chapter details', {
          chapterId,
          title: dto.title,
        })
        .catch(() => null);
    }

    this.posthog.capture(userId, 'chapter_updated', {
      chapterId,
      fields_updated: fieldsUpdated,
    });

    if (dto.status === 'complete') {
      // A completed chapter is a saved memoir entry. `chapter` carries the
      // theme (non-PII) — never the title.
      this.posthog.capture(userId, 'memoir_entry_saved', {
        chapterId,
        chapter: updated.theme ?? null,
        word_count: updated.word_count,
      });
    }

    return updated;
  }

  async autosave(userId: string, chapterId: string, dto: AutosaveChapterDto) {
    const chapter = await this.requireOwnedChapter(userId, chapterId);

    const updates: Record<string, unknown> = {
      body: sanitizeHtml(dto.body, SANITIZE_OPTIONS),
      word_count: dto.word_count,
      updated_at: new Date().toISOString(),
    };
    if (chapter.status === 'draft') {
      updates.status = 'in_progress';
    }

    const { data: updated, error } = await this.supabase
      .getClient()
      .from('chapters')
      .update(updates)
      .eq('id', chapterId)
      .select('updated_at, status')
      .single();

    if (error || !updated) {
      throw new InternalServerErrorException('Failed to autosave chapter');
    }

    return updated;
  }

  async deleteChapter(userId: string, chapterId: string) {
    const chapter = await this.requireOwnedChapter(userId, chapterId);

    const { data: exhibits } = await this.supabase
      .getClient()
      .from('chapter_exhibits')
      .select('storage_path')
      .eq('chapter_id', chapterId);

    const paths = (exhibits ?? []).map((e) => e.storage_path);
    if (paths.length > 0) {
      await this.supabase
        .getClient()
        .storage.from('chapter-exhibits')
        .remove(paths);
    }

    // Delete voice recording from audio bucket if present
    if (chapter.audio_storage_path) {
      await this.supabase
        .getClient()
        .storage.from('audio')
        .remove([chapter.audio_storage_path]);
    }

    // Delete TTS audio if present
    const { data: ttsRow } = await this.supabase
      .getClient()
      .from('chapter_tts')
      .select('storage_path')
      .eq('chapter_id', chapterId)
      .single();

    if (ttsRow?.storage_path) {
      await this.supabase
        .getClient()
        .storage.from('chapter-audio')
        .remove([ttsRow.storage_path]);
    }

    await this.supabase
      .getClient()
      .from('content_assignments')
      .delete()
      .eq('content_type', 'chapter')
      .eq('content_id', chapterId);

    const { error } = await this.supabase
      .getClient()
      .from('chapters')
      .delete()
      .eq('id', chapterId);

    if (error) {
      throw new InternalServerErrorException('Failed to delete chapter');
    }

    await this.closeDisplayOrderGap(userId);

    this.activityService
      .log(userId, 'chapter_deleted', 'Deleted a chapter', {
        chapterId,
        title: chapter.title,
      })
      .catch(() => null);

    this.posthog.capture(userId, 'chapter_deleted', {
      chapterId,
    });

    return { message: 'Chapter deleted successfully' };
  }

  async reorderChapters(userId: string, dto: ReorderChaptersDto) {
    const ids = dto.order.map((o) => o.id);

    const { data: owned, error } = await this.supabase
      .getClient()
      .from('chapters')
      .select('id')
      .eq('user_id', userId)
      .in('id', ids);

    if (error) {
      throw new InternalServerErrorException('Failed to verify chapters');
    }

    const ownedIds = new Set((owned ?? []).map((c) => c.id));
    if (ids.some((id) => !ownedIds.has(id))) {
      throw new BadRequestException(
        'One or more chapters do not belong to this account',
      );
    }

    const results = await Promise.all(
      dto.order.map((item) =>
        this.supabase
          .getClient()
          .from('chapters')
          .update({ display_order: item.display_order })
          .eq('id', item.id),
      ),
    );
    if (results.some((r) => r.error)) {
      throw new InternalServerErrorException('Failed to reorder chapters');
    }

    this.activityService
      .log(userId, 'chapters_reordered', 'Reordered memoir chapters', {
        order: dto.order,
      })
      .catch(() => null);

    return { message: 'Chapters reordered successfully' };
  }

  async getExhibitUploadUrl(
    userId: string,
    chapterId: string,
    dto: RequestExhibitUploadUrlDto,
  ) {
    await this.requireOwnedChapter(userId, chapterId);

    const storagePath = `${userId}/${chapterId}/${randomUUID()}-${sanitizeFileName(dto.file_name)}`;

    const { data, error } = await this.supabase
      .getClient()
      .storage.from('chapter-exhibits')
      .createSignedUploadUrl(storagePath);

    if (error || !data) {
      throw new InternalServerErrorException('Failed to generate upload URL');
    }

    return {
      upload_url: data.signedUrl,
      storage_path: storagePath,
    };
  }

  async createExhibit(
    userId: string,
    chapterId: string,
    dto: CreateExhibitDto,
  ) {
    await this.requireOwnedChapter(userId, chapterId);

    // storage_path must have been minted for THIS user+chapter — never trust a
    // client-supplied path pointing at another tenant's object.
    if (!dto.storage_path.startsWith(`${userId}/${chapterId}/`)) {
      throw new ForbiddenException('storage_path does not belong to this chapter');
    }

    // display_order is computed and inserted atomically in one RPC so
    // concurrent creates can't persist duplicate orders (see db/atomic-functions.sql).
    const { data, error } = await this.supabase
      .getClient()
      .rpc('insert_exhibit_ordered', {
        p_chapter_id: chapterId,
        p_user_id: userId,
        p_data: {
          file_name: dto.file_name,
          storage_path: dto.storage_path,
          file_type: dto.file_type ?? null,
          file_size_bytes: dto.file_size_bytes ?? null,
          width: dto.width ?? null,
          height: dto.height ?? null,
        },
      })
      .single();

    const created = data as Record<string, any> | null;
    if (error || !created) {
      throw new InternalServerErrorException('Failed to save exhibit');
    }

    this.activityService
      .log(userId, 'exhibit_added', 'Added an exhibit to a chapter', {
        chapterId,
        exhibitId: created.id,
        fileName: created.file_name,
      })
      .catch(() => null);

    this.posthog.capture(userId, 'exhibit_added', {
      chapterId,
      exhibitId: created.id,
      file_type: created.file_type,
    });

    const [exhibit] = await this.attachSignedUrls([created]);
    return exhibit;
  }

  async listExhibits(userId: string, chapterId: string) {
    await this.requireOwnedChapter(userId, chapterId);

    const { data, error } = await this.supabase
      .getClient()
      .from('chapter_exhibits')
      .select('*')
      .eq('chapter_id', chapterId)
      .order('display_order', { ascending: true });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch exhibits');
    }

    const exhibits = await this.attachSignedUrls(data ?? []);
    return { exhibits, count: exhibits.length };
  }

  async deleteExhibit(userId: string, chapterId: string, exhibitId: string) {
    await this.requireOwnedChapter(userId, chapterId);

    const { data: exhibit, error } = await this.supabase
      .getClient()
      .from('chapter_exhibits')
      .select('*')
      .eq('id', exhibitId)
      .eq('chapter_id', chapterId)
      .eq('user_id', userId)
      .single();

    if (error || !exhibit) {
      throw new NotFoundException('Exhibit not found');
    }

    await this.supabase
      .getClient()
      .storage.from('chapter-exhibits')
      .remove([exhibit.storage_path]);

    const { error: deleteError } = await this.supabase
      .getClient()
      .from('chapter_exhibits')
      .delete()
      .eq('id', exhibitId);

    if (deleteError) {
      throw new InternalServerErrorException('Failed to delete exhibit');
    }

    this.activityService
      .log(userId, 'exhibit_removed', 'Removed an exhibit from a chapter', {
        chapterId,
        exhibitId,
      })
      .catch(() => null);

    return { message: 'Exhibit deleted successfully' };
  }

  async setAssignments(
    userId: string,
    chapterId: string,
    dto: SetChapterAssignmentsDto,
  ) {
    await this.requireOwnedChapter(userId, chapterId);

    const hasAssignLater = dto.assignments.some(
      (a) => a.assignment_scope === 'assign_later',
    );
    const effective: ChapterAssignmentDto[] = hasAssignLater
      ? [{ assignment_scope: 'assign_later' }]
      : dto.assignments.length > 0
        ? dto.assignments
        : [{ assignment_scope: 'assign_later' }];

    for (const a of effective) {
      if (a.assignment_scope === 'group' && !a.group_value) {
        throw new BadRequestException(
          'group_value is required when assignment_scope is "group"',
        );
      }
      if (a.assignment_scope === 'individual' && !a.recipient_id) {
        throw new BadRequestException(
          'recipient_id is required when assignment_scope is "individual"',
        );
      }
    }

    // Cross-tenant guard: every individual recipient must belong to this user.
    await this.assertRecipientsOwned(
      userId,
      effective
        .filter((a) => a.assignment_scope === 'individual' && a.recipient_id)
        .map((a) => a.recipient_id as string),
    );

    const rows = effective.map((a) => ({
      assignment_scope: a.assignment_scope,
      group_value:
        a.assignment_scope === 'group' ? (a.group_value ?? null) : null,
      recipient_id:
        a.assignment_scope === 'individual' ? (a.recipient_id ?? null) : null,
    }));

    // Delete the old assignments and insert the replacement atomically. If the
    // insert fails the delete rolls back, so the chapter is never left with no
    // assignments (unlike a delete-then-insert pair of round trips).
    const { data, error } = await this.supabase
      .getClient()
      .rpc('replace_content_assignments', {
        p_user_id: userId,
        p_content_type: 'chapter',
        p_content_id: chapterId,
        p_rows: rows,
      });

    const created = data as Array<Record<string, any>> | null;
    if (error || !created) {
      throw new InternalServerErrorException('Failed to create assignment');
    }

    const recipientIds = created
      .filter((a) => a.assignment_scope === 'individual' && a.recipient_id)
      .map((a) => a.recipient_id as string);
    const recipientMap = await this.resolveRecipientNames(userId, recipientIds);

    const assignments = created.map((a) =>
      this.withRecipientName(a, recipientMap),
    );

    // Persist recipient note: absent key = leave unchanged, empty string = clear
    let savedNote: string | null | undefined = undefined;
    if (dto.note !== undefined) {
      const noteValue = dto.note === '' ? null : dto.note;
      await this.supabase
        .getClient()
        .from('chapters')
        .update({ recipient_note: noteValue, updated_at: new Date().toISOString() })
        .eq('id', chapterId);
      savedNote = noteValue;
    } else {
      const { data: current } = await this.supabase
        .getClient()
        .from('chapters')
        .select('recipient_note')
        .eq('id', chapterId)
        .single();
      savedNote = current?.recipient_note ?? null;
    }

    this.activityService
      .log(
        userId,
        'chapter_assignments_updated',
        'Updated chapter assignments',
        { chapterId, assignmentCount: assignments.length },
      )
      .catch(() => null);

    this.posthog.capture(userId, 'chapter_assignments_updated', {
      chapterId,
      assignment_count: assignments.length,
      scopes: assignments.map((a) => a.assignment_scope),
    });

    return { assignments, count: assignments.length, note: savedNote ?? null };
  }

  async getAssignments(userId: string, chapterId: string) {
    const { data: chapter } = await this.supabase
      .getClient()
      .from('chapters')
      .select('id, recipient_note')
      .eq('id', chapterId)
      .eq('user_id', userId)
      .single();

    if (!chapter) throw new NotFoundException('Chapter not found');

    const { assignmentsByChapter, recipientIds } = await this.fetchAssignments(
      [chapterId],
      true,
    );
    const recipientMap = await this.resolveRecipientNames(userId, recipientIds);
    const assignments = (assignmentsByChapter.get(chapterId) ?? []).map((a) =>
      this.withRecipientName(a, recipientMap),
    );

    return {
      assignments,
      count: assignments.length,
      note: chapter.recipient_note ?? null,
    };
  }

  // ─── Voice Chapters ─────────────────────────────────────────────────────────

  async getVoiceUploadUrl(userId: string, dto: RequestVoiceUploadUrlDto) {
    if (!dto.file_type.startsWith('audio/')) {
      throw new BadRequestException('file_type must be an audio MIME type');
    }

    const storagePath = `voice-chapters/${userId}/${randomUUID()}-${sanitizeFileName(dto.file_name)}`;

    const { data, error } = await this.supabase
      .getClient()
      .storage.from('audio')
      .createSignedUploadUrl(storagePath);

    if (error || !data) {
      throw new InternalServerErrorException('Failed to generate upload URL');
    }

    return {
      upload_url: data.signedUrl,
      storage_path: storagePath,
    };
  }

  async createVoiceChapter(userId: string, dto: CreateVoiceChapterDto) {
    // Reject an audio path that wasn't minted for this user (cross-tenant read).
    if (!dto.storage_path.startsWith(`voice-chapters/${userId}/`)) {
      throw new ForbiddenException('storage_path does not belong to this user');
    }

    // display_order is computed and inserted atomically in one RPC so
    // concurrent creates can't persist duplicate orders (see db/atomic-functions.sql).
    const { data, error } = await this.supabase
      .getClient()
      .rpc('insert_chapter_ordered', {
        p_user_id: userId,
        p_data: {
          title: dto.title,
          date_label: dto.date_label ?? null,
          theme: dto.theme ?? null,
          type: 'voice',
          status: 'draft',
          audio_storage_path: dto.storage_path,
          audio_duration_seconds: dto.duration_seconds ?? null,
          audio_file_size_bytes: dto.file_size_bytes,
          audio_mime_type: dto.file_type,
          transcription_status: 'pending',
        },
      })
      .single();

    const created = data as Record<string, any> | null;
    if (error || !created) {
      throw new InternalServerErrorException('Failed to create voice chapter');
    }

    this.activityService
      .log(userId, 'voice_chapter_created', 'Created a voice chapter', {
        chapterId: created.id,
        title: created.title,
      })
      .catch(() => null);

    this.posthog.capture(userId, 'voice_chapter_created', {
      chapterId: created.id,
      duration_seconds: dto.duration_seconds,
    });

    this.transcribeVoiceChapter(userId, created.id, dto.storage_path).catch(
      (err) => {
        this.logger.error(
          `Transcription failed for chapter ${created.id}`,
          err,
        );
      },
    );

    return created;
  }

  async getTranscriptionStatus(userId: string, chapterId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('chapters')
      .select('transcription_status, word_count, status')
      .eq('id', chapterId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      throw new NotFoundException('Chapter not found');
    }

    return {
      transcription_status: data.transcription_status,
      word_count: data.word_count ?? 0,
      status: data.status,
    };
  }

  private async transcribeVoiceChapter(
    userId: string,
    chapterId: string,
    storagePath: string,
  ) {
    const supabase = this.supabase.getClient();

    await supabase
      .from('chapters')
      .update({
        transcription_status: 'processing',
        updated_at: new Date().toISOString(),
      })
      .eq('id', chapterId);

    try {
      const { data: urlData } = await supabase.storage
        .from('audio')
        .createSignedUrl(storagePath, 3600);

      if (!urlData?.signedUrl) {
        throw new Error('Failed to get signed URL for audio');
      }

      const apiKey = this.config.get<string>('DEEPGRAM_API_KEY');
      if (!apiKey) throw new Error('DEEPGRAM_API_KEY not configured');

      const deepgram = new DeepgramClient({ apiKey });
      const response = await withTimeout(
        deepgram.listen.v1.media.transcribeUrl({
          url: urlData.signedUrl,
          model: 'nova-2',
          smart_format: true,
          paragraphs: true,
          punctuate: true,
          utterances: true,
        }),
        TRANSCRIPTION_TIMEOUT_MS,
        'Deepgram voice-chapter transcription',
      );

      const r = response as unknown as {
        results?: {
          channels?: Array<{
            alternatives?: Array<{
              transcript?: string;
              paragraphs?: {
                paragraphs?: Array<{
                  sentences: Array<{ text: string }>;
                }>;
              };
            }>;
          }>;
        };
      };

      const paragraphs =
        r?.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs;

      let bodyHtml = '';
      if (paragraphs && paragraphs.length > 0) {
        bodyHtml = paragraphs
          .map((p) => `<p>${p.sentences.map((s) => s.text).join(' ')}</p>`)
          .join('');
      } else {
        const transcript =
          r?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
        bodyHtml = transcript ? `<p>${transcript}</p>` : '';
      }

      const plainText = bodyHtml.replace(/<[^>]*>/g, ' ').trim();
      const wordCount = plainText ? plainText.split(/\s+/).length : 0;

      await supabase
        .from('chapters')
        .update({
          body: bodyHtml,
          word_count: wordCount,
          transcription_status: 'completed',
          status: wordCount > 0 ? 'in_progress' : 'draft',
          updated_at: new Date().toISOString(),
        })
        .eq('id', chapterId);

      this.activityService
        .log(
          userId,
          'voice_chapter_transcribed',
          'Voice chapter transcribed',
          { chapterId, wordCount },
        )
        .catch(() => null);

      this.posthog.capture(userId, 'voice_chapter_transcribed', {
        chapterId,
        wordCount,
      });
    } catch (error) {
      await supabase
        .from('chapters')
        .update({
          transcription_status: 'failed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', chapterId);

      this.activityService
        .log(
          userId,
          'voice_chapter_transcription_failed',
          'Voice transcription failed',
          { chapterId },
        )
        .catch(() => null);
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async requireOwnedChapter(userId: string, chapterId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('chapters')
      .select('*')
      .eq('id', chapterId)
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Chapter not found');
    return data;
  }

  private hasContent(body: string | null | undefined): boolean {
    if (!body) return false;
    return (
      sanitizeHtml(body, { allowedTags: [], allowedAttributes: {} }).trim()
        .length > 0
    );
  }

  private async attachSignedUrls(exhibits: Record<string, unknown>[]) {
    if (exhibits.length === 0) return [];

    const { data: urlResults } = await this.supabase
      .getClient()
      .storage.from('chapter-exhibits')
      .createSignedUrls(
        exhibits.map((e) => e.storage_path as string),
        3600,
      );

    const urlMap = new Map(
      (urlResults ?? []).map((r) => [r.path, r.signedUrl]),
    );

    return exhibits.map((e) => ({
      ...e,
      signed_url: urlMap.get(e.storage_path as string) ?? null,
    }));
  }

  private async fetchAssignments(
    chapterIds: string[],
    includeRelationship = false,
  ) {
    const select = includeRelationship
      ? 'content_id, assignment_scope, group_value, recipient_id'
      : 'content_id, assignment_scope, group_value, recipient_id';

    const { data } = await this.supabase
      .getClient()
      .from('content_assignments')
      .select(select)
      .eq('content_type', 'chapter')
      .in('content_id', chapterIds);

    const assignmentsByChapter = new Map<string, Record<string, unknown>[]>();
    const recipientIds: string[] = [];
    for (const a of data ?? []) {
      const list = assignmentsByChapter.get(a.content_id) ?? [];
      list.push(a);
      assignmentsByChapter.set(a.content_id, list);
      if (a.assignment_scope === 'individual' && a.recipient_id) {
        recipientIds.push(a.recipient_id);
      }
    }

    return { assignmentsByChapter, recipientIds };
  }

  private async assertRecipientsOwned(userId: string, recipientIds: string[]) {
    const unique = [...new Set(recipientIds)];
    if (unique.length === 0) return;
    const found = await this.recipientsService.findByIds(userId, unique);
    if (found.length !== unique.length) {
      throw new ForbiddenException(
        'One or more recipients do not belong to this account',
      );
    }
  }

  private async resolveRecipientNames(userId: string, recipientIds: string[]) {
    const uniqueIds = [...new Set(recipientIds)];
    const recipients = await this.recipientsService.findByIds(
      userId,
      uniqueIds,
    );
    return new Map(recipients.map((r) => [r.id, r]));
  }

  private withRecipientName(
    assignment: Record<string, unknown>,
    recipientMap: Map<
      string,
      { id: string; name: string; relationship: string }
    >,
  ) {
    if (
      assignment.assignment_scope !== 'individual' ||
      !assignment.recipient_id
    ) {
      return assignment;
    }
    const recipient = recipientMap.get(assignment.recipient_id as string);
    return {
      ...assignment,
      recipient_name: recipient?.name ?? null,
      relationship: recipient?.relationship ?? null,
    };
  }

  private async closeDisplayOrderGap(userId: string) {
    const { data: remaining } = await this.supabase
      .getClient()
      .from('chapters')
      .select('id')
      .eq('user_id', userId)
      .order('display_order', { ascending: true });

    if (!remaining) return;

    await Promise.all(
      remaining.map((chapter, i) =>
        this.supabase
          .getClient()
          .from('chapters')
          .update({ display_order: i })
          .eq('id', chapter.id),
      ),
    );
  }
}
