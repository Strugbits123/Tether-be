import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { TtsService } from './tts.service.js';
import { PdfService } from './pdf.service.js';
import { UpdateMemoirDto } from './dto/update-memoir.dto.js';
import { DeleteMemoirDto } from './dto/delete-memoir.dto.js';
import { GenerateTtsDto } from './dto/generate-tts.dto.js';

@Injectable()
export class MemoirService {
  private readonly logger = new Logger(MemoirService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
    private readonly ttsService: TtsService,
    private readonly pdfService: PdfService,
  ) {}

  async getMemoir(userId: string) {
    const memoir = await this.upsertMemoir(userId);
    const stats = await this.buildStats(userId);
    return { ...memoir, stats };
  }

  async updateMemoir(userId: string, dto: UpdateMemoirDto) {
    const memoir = await this.upsertMemoir(userId);

    const { data: updated, error } = await this.supabase
      .getClient()
      .from('memoirs')
      .update({
        title: dto.title ?? memoir.title,
        dedication: dto.dedication ?? memoir.dedication,
        updated_at: new Date().toISOString(),
      })
      .eq('id', memoir.id)
      .select('id, title, dedication, updated_at')
      .single();

    if (error || !updated) {
      throw new InternalServerErrorException('Failed to update memoir');
    }

    this.activityService
      .log(userId, 'memoir_updated', 'Updated memoir settings', {
        memoirId: memoir.id,
      })
      .catch(() => null);

    const fieldsUpdated = Object.keys(dto).filter(
      (k) => dto[k as keyof UpdateMemoirDto] !== undefined,
    );
    this.posthog.capture(userId, 'memoir_updated', {
      memoirId: memoir.id,
      fields_updated: fieldsUpdated,
    });

    return updated;
  }

  async deleteMemoir(userId: string, dto: DeleteMemoirDto) {
    if (dto.confirm !== 'delete my story') {
      throw new BadRequestException('Please type "delete my story" to confirm.');
    }

    const supabase = this.supabase.getClient();

    const { data: chapters } = await supabase
      .from('chapters')
      .select('id, audio_storage_path')
      .eq('user_id', userId);

    const chapterIds = (chapters ?? []).map((c: { id: string }) => c.id);

    if (chapterIds.length > 0) {
      // Delete exhibit files
      const { data: exhibits } = await supabase
        .from('chapter_exhibits')
        .select('storage_path')
        .in('chapter_id', chapterIds);

      const exhibitPaths = (exhibits ?? []).map(
        (e: { storage_path: string }) => e.storage_path,
      );
      if (exhibitPaths.length > 0) {
        const { error } = await supabase.storage
          .from('chapter-exhibits')
          .remove(exhibitPaths);
        // Orphaned storage files are non-critical (the DB rows still go away),
        // so log and continue rather than aborting the whole deletion.
        if (error) {
          this.logger.warn(
            `Failed to remove exhibit files for user ${userId}: ${error.message}`,
          );
        }
      }

      // Delete TTS audio files
      const { data: ttsRows } = await supabase
        .from('chapter_tts')
        .select('storage_path')
        .in('chapter_id', chapterIds);

      const ttsPaths = (ttsRows ?? []).map(
        (t: { storage_path: string }) => t.storage_path,
      );
      if (ttsPaths.length > 0) {
        const { error } = await supabase.storage
          .from('chapter-audio')
          .remove(ttsPaths);
        if (error) {
          this.logger.warn(
            `Failed to remove TTS audio for user ${userId}: ${error.message}`,
          );
        }
      }

      // Delete voice recording files
      const voicePaths = (chapters ?? [])
        .filter((c: { audio_storage_path?: string | null }) => c.audio_storage_path)
        .map((c: { audio_storage_path: string }) => c.audio_storage_path);
      if (voicePaths.length > 0) {
        const { error } = await supabase.storage.from('audio').remove(voicePaths);
        if (error) {
          this.logger.warn(
            `Failed to remove voice recordings for user ${userId}: ${error.message}`,
          );
        }
      }

      // Delete assignments — critical: a failure here would leave assignment
      // rows pointing at chapters we're about to delete, so abort.
      const { error: assignmentError } = await supabase
        .from('content_assignments')
        .delete()
        .eq('content_type', 'chapter')
        .in('content_id', chapterIds);
      if (assignmentError) {
        this.logger.error(
          `Failed to delete chapter assignments for user ${userId}: ${assignmentError.message}`,
        );
        throw new InternalServerErrorException('Failed to delete story');
      }
    }

    // Delete all chapters (cascades chapter_tts and chapter_exhibits rows).
    // Critical: abort on failure so we never report success with surviving rows.
    const { error: chaptersError } = await supabase
      .from('chapters')
      .delete()
      .eq('user_id', userId);
    if (chaptersError) {
      this.logger.error(
        `Failed to delete chapters for user ${userId}: ${chaptersError.message}`,
      );
      throw new InternalServerErrorException('Failed to delete story');
    }

    // Delete memoir row
    const { data: memoir } = await supabase
      .from('memoirs')
      .select('id')
      .eq('user_id', userId)
      .single();

    const { error: memoirError } = await supabase
      .from('memoirs')
      .delete()
      .eq('user_id', userId);
    if (memoirError) {
      this.logger.error(
        `Failed to delete memoir row for user ${userId}: ${memoirError.message}`,
      );
      throw new InternalServerErrorException('Failed to delete story');
    }

    this.activityService
      .log(userId, 'memoir_deleted', 'Deleted entire story', {
        memoirId: memoir?.id,
        chapters_deleted: chapterIds.length,
      })
      .catch(() => null);

    this.posthog.capture(userId, 'memoir_deleted', {
      memoirId: memoir?.id,
      chapters_deleted: chapterIds.length,
    });

    return { message: 'Your story has been permanently deleted.' };
  }

  async getPreview(userId: string) {
    const memoir = await this.upsertMemoir(userId);

    const { data: chapters, error } = await this.supabase
      .getClient()
      .from('chapters')
      .select(
        'id, title, date_label, theme, type, status, body, word_count, display_order, recipient_note',
      )
      .eq('user_id', userId)
      .order('display_order', { ascending: true });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch chapters');
    }

    const chapterList = chapters ?? [];
    let hasAudio = false;
    let totalWords = 0;

    const chapterIds = chapterList.map((c) => c.id);

    // Batch-fetch all exhibits and TTS rows (2 queries instead of 2N)
    const [{ data: allExhibits }, { data: allTtsRows }] = await Promise.all([
      chapterIds.length
        ? this.supabase
            .getClient()
            .from('chapter_exhibits')
            .select('id, chapter_id, file_name, file_type, storage_path, display_order')
            .in('chapter_id', chapterIds)
            .order('display_order', { ascending: true })
        : Promise.resolve({ data: [] as any[] }),
      chapterIds.length
        ? this.supabase
            .getClient()
            .from('chapter_tts')
            .select('chapter_id, status, storage_path, duration_seconds')
            .in('chapter_id', chapterIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);

    // Batch signed URLs for all exhibits and ready TTS audio (2 calls instead of 2N)
    const exhibitPaths = (allExhibits ?? []).map((e: any) => e.storage_path as string);
    const readyTtsPaths = (allTtsRows ?? [])
      .filter((t: any) => t.status === 'ready' && t.storage_path)
      .map((t: any) => t.storage_path as string);

    const [{ data: exhibitUrlData }, { data: ttsUrlData }] = await Promise.all([
      exhibitPaths.length
        ? this.supabase.getClient().storage.from('chapter-exhibits').createSignedUrls(exhibitPaths, 3600)
        : Promise.resolve({ data: [] as any[] }),
      readyTtsPaths.length
        ? this.supabase.getClient().storage.from('chapter-audio').createSignedUrls(readyTtsPaths, 3600)
        : Promise.resolve({ data: [] as any[] }),
    ]);

    const exhibitUrlMap = new Map(
      (exhibitUrlData ?? []).filter((u: any) => u.path && u.signedUrl).map((u: any) => [u.path as string, u.signedUrl as string]),
    );
    const ttsUrlMap = new Map(
      (ttsUrlData ?? []).filter((u: any) => u.path && u.signedUrl).map((u: any) => [u.path as string, u.signedUrl as string]),
    );

    const exhibitsByChapter = (allExhibits ?? []).reduce<Record<string, any[]>>((acc, e: any) => {
      (acc[e.chapter_id] ??= []).push(e);
      return acc;
    }, {});
    const ttsByChapter = (allTtsRows ?? []).reduce<Record<string, any>>((acc, t: any) => {
      acc[t.chapter_id] = t;
      return acc;
    }, {});

    const enriched = chapterList.map((chapter, index) => {
      totalWords += chapter.word_count ?? 0;

      const exhibits = (exhibitsByChapter[chapter.id] ?? []).map((e: any) => ({
        id: e.id,
        file_name: e.file_name,
        file_type: e.file_type,
        signed_url: exhibitUrlMap.get(e.storage_path) ?? null,
      }));

      const ttsRow = ttsByChapter[chapter.id] ?? null;
      let ttsAudio: { status: string; playback_url: string | null; duration_seconds: number | null } | null = null;
      if (ttsRow) {
        if (ttsRow.status === 'ready' && ttsRow.storage_path) hasAudio = true;
        ttsAudio = {
          status: ttsRow.status,
          playback_url: ttsRow.storage_path ? (ttsUrlMap.get(ttsRow.storage_path) ?? null) : null,
          duration_seconds: ttsRow.duration_seconds ?? null,
        };
      }

      return {
        chapter_number: index + 1,
        id: chapter.id,
        title: chapter.title,
        date_label: chapter.date_label,
        theme: chapter.theme,
        type: chapter.type,
        body: chapter.body,
        word_count: chapter.word_count,
        recipient_note: chapter.recipient_note ?? null,
        exhibits,
        tts_audio: ttsAudio,
      };
    });

    return {
      title: memoir.title,
      dedication: memoir.dedication,
      chapters: enriched,
      total_words: totalWords,
      total_chapters: chapterList.length,
      has_tts_audio: hasAudio,
    };
  }

  async downloadPdf(userId: string) {
    const preview = await this.getPreview(userId);
    const result = await this.pdfService.generatePdf(preview);

    this.activityService
      .log(userId, 'memoir_downloaded_pdf', 'Downloaded memoir as PDF', {
        chapter_count: preview.total_chapters,
        total_words: preview.total_words,
      })
      .catch(() => null);

    this.posthog.capture(userId, 'memoir_downloaded', {
      format: 'pdf',
      chapter_count: preview.total_chapters,
      total_words: preview.total_words,
    });

    return result;
  }

  async downloadText(userId: string) {
    const preview = await this.getPreview(userId);
    const result = this.pdfService.generateText(preview);

    this.activityService
      .log(userId, 'memoir_downloaded_text', 'Downloaded memoir as text', {
        chapter_count: preview.total_chapters,
        total_words: preview.total_words,
      })
      .catch(() => null);

    this.posthog.capture(userId, 'memoir_downloaded', {
      format: 'text',
      chapter_count: preview.total_chapters,
      total_words: preview.total_words,
    });

    return result;
  }

  // ─── TTS ─────────────────────────────────────────────────────────────────────

  async startTts(userId: string, chapterId: string, dto: GenerateTtsDto) {
    const { data: chapter } = await this.supabase
      .getClient()
      .from('chapters')
      .select('id, body')
      .eq('id', chapterId)
      .eq('user_id', userId)
      .single();

    if (!chapter) throw new NotFoundException('Chapter not found');
    if (!chapter.body) {
      throw new BadRequestException('Chapter has no content to narrate');
    }

    const { data: existing } = await this.supabase
      .getClient()
      .from('chapter_tts')
      .select('id, status, storage_path')
      .eq('chapter_id', chapterId)
      .single();

    if (existing?.status === 'processing') {
      throw new BadRequestException(
        'Audio generation is already in progress for this chapter',
      );
    }

    if (existing) {
      if (existing.storage_path) {
        await this.supabase
          .getClient()
          .storage.from('chapter-audio')
          .remove([existing.storage_path]);
      }
      await this.supabase
        .getClient()
        .from('chapter_tts')
        .delete()
        .eq('id', existing.id);
    }

    const voiceModel = dto.voice_model ?? this.ttsService.defaultVoice;

    const { data: ttsRow, error } = await this.supabase
      .getClient()
      .from('chapter_tts')
      .insert({
        chapter_id: chapterId,
        user_id: userId,
        storage_path: '',
        voice_model: voiceModel,
        status: 'pending',
      })
      .select('id, chapter_id, status, voice_model')
      .single();

    if (error || !ttsRow) {
      throw new InternalServerErrorException('Failed to start TTS generation');
    }

    this.activityService
      .log(userId, 'tts_generation_started', 'Started audio narration', {
        chapterId,
        voice_model: voiceModel,
      })
      .catch(() => null);

    this.posthog.capture(userId, 'tts_generation_started', {
      chapterId,
      voice_model: voiceModel,
      body_length: (chapter.body as string).length,
    });

    this.ttsService
      .generateTts(userId, chapterId, ttsRow.id, voiceModel)
      .catch((err) => {
        this.logger.error(`TTS generation error for chapter ${chapterId}`, err instanceof Error ? err.stack : err);
      });

    return {
      id: ttsRow.id,
      chapter_id: chapterId,
      status: 'pending',
      voice_model: voiceModel,
      message:
        'Audio generation started. Poll GET /memoir/chapters/:id/tts for status.',
    };
  }

  async getTtsStatus(userId: string, chapterId: string) {
    await this.requireOwnedChapter(userId, chapterId);

    const { data: ttsRow } = await this.supabase
      .getClient()
      .from('chapter_tts')
      .select(
        'id, chapter_id, status, storage_path, duration_seconds, file_size_bytes, voice_model, created_at',
      )
      .eq('chapter_id', chapterId)
      .single();

    if (!ttsRow) return { status: 'none' };

    let playback_url: string | null = null;
    if (ttsRow.status === 'ready' && ttsRow.storage_path) {
      const { data: urlData } = await this.supabase
        .getClient()
        .storage.from('chapter-audio')
        .createSignedUrl(ttsRow.storage_path, 3600);
      playback_url = urlData?.signedUrl ?? null;
    }

    return {
      id: ttsRow.id,
      chapter_id: ttsRow.chapter_id,
      status: ttsRow.status,
      playback_url,
      duration_seconds: ttsRow.duration_seconds ?? null,
      file_size_bytes: ttsRow.file_size_bytes ?? null,
      voice_model: ttsRow.voice_model,
      created_at: ttsRow.created_at,
    };
  }

  async deleteTts(userId: string, chapterId: string) {
    await this.requireOwnedChapter(userId, chapterId);

    const { data: ttsRow } = await this.supabase
      .getClient()
      .from('chapter_tts')
      .select('id, storage_path')
      .eq('chapter_id', chapterId)
      .single();

    if (!ttsRow) throw new NotFoundException('No TTS audio found for this chapter');

    if (ttsRow.storage_path) {
      await this.supabase
        .getClient()
        .storage.from('chapter-audio')
        .remove([ttsRow.storage_path]);
    }

    await this.supabase
      .getClient()
      .from('chapter_tts')
      .delete()
      .eq('id', ttsRow.id);

    this.activityService
      .log(userId, 'tts_deleted', 'Deleted audio narration', { chapterId })
      .catch(() => null);

    return { message: 'Audio narration deleted.' };
  }

  async getBatchTtsStatus(userId: string) {
    const { data: chapters } = await this.supabase
      .getClient()
      .from('chapters')
      .select('id, title')
      .eq('user_id', userId)
      .order('display_order', { ascending: true });

    const chapterList = chapters ?? [];
    if (chapterList.length === 0) {
      return { chapters: [], all_ready: true, ready_count: 0, total_chapters: 0 };
    }

    const chapterIds = chapterList.map((c: { id: string }) => c.id);

    const { data: ttsRows } = await this.supabase
      .getClient()
      .from('chapter_tts')
      .select('chapter_id, status, duration_seconds')
      .in('chapter_id', chapterIds);

    const ttsMap = new Map(
      (ttsRows ?? []).map(
        (t: { chapter_id: string; status: string; duration_seconds?: number | null }) => [
          t.chapter_id,
          t,
        ],
      ),
    );

    const result = chapterList.map((ch: { id: string; title: string }) => {
      const tts = ttsMap.get(ch.id);
      return {
        chapter_id: ch.id,
        title: ch.title,
        status: tts?.status ?? 'none',
        duration_seconds: tts?.duration_seconds ?? null,
      };
    });

    const readyCount = result.filter(
      (r: { status: string }) => r.status === 'ready',
    ).length;

    return {
      chapters: result,
      all_ready: readyCount === chapterList.length,
      ready_count: readyCount,
      total_chapters: chapterList.length,
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async upsertMemoir(userId: string) {
    // Single atomic upsert on the unique user_id, so two concurrent first-time
    // requests can't double-create rows or have one fail. ignoreDuplicates is
    // intentionally NOT set: on conflict we want the existing row returned, not
    // an empty result. onConflict only touches user_id, leaving any existing
    // title/dedication untouched. Requires a UNIQUE constraint on
    // memoirs.user_id (see db/constraints.sql).
    const { data, error } = await this.supabase
      .getClient()
      .from('memoirs')
      .upsert({ user_id: userId }, { onConflict: 'user_id' })
      .select('*')
      .single();

    if (error || !data) {
      throw new InternalServerErrorException('Failed to initialise memoir');
    }

    return data;
  }

  private async buildStats(userId: string) {
    const { data: chapters } = await this.supabase
      .getClient()
      .from('chapters')
      .select('id, status, word_count')
      .eq('user_id', userId);

    const rows = chapters ?? [];
    const chapterIds = rows.map((c: { id: string }) => c.id);

    let recipientsAssigned = 0;
    if (chapterIds.length > 0) {
      const { data: assignmentRows } = await this.supabase
        .getClient()
        .from('content_assignments')
        .select('recipient_id')
        .eq('content_type', 'chapter')
        .in('content_id', chapterIds)
        .eq('assignment_scope', 'individual');

      const uniqueRecipients = new Set(
        (assignmentRows ?? [])
          .filter((a: { recipient_id?: string | null }) => a.recipient_id)
          .map((a: { recipient_id: string }) => a.recipient_id),
      );
      recipientsAssigned = uniqueRecipients.size;
    }

    let chaptersWithAudio = 0;
    if (chapterIds.length > 0) {
      const { data: ttsRows } = await this.supabase
        .getClient()
        .from('chapter_tts')
        .select('chapter_id')
        .in('chapter_id', chapterIds)
        .eq('status', 'ready');
      chaptersWithAudio = (ttsRows ?? []).length;
    }

    return {
      total_chapters: rows.length,
      completed_chapters: rows.filter(
        (c: { status: string }) => c.status === 'complete',
      ).length,
      in_progress_chapters: rows.filter(
        (c: { status: string }) => c.status === 'in_progress',
      ).length,
      draft_chapters: rows.filter((c: { status: string }) => c.status === 'draft')
        .length,
      total_words: rows.reduce(
        (sum: number, c: { word_count?: number | null }) => sum + (c.word_count ?? 0),
        0,
      ),
      recipients_assigned: recipientsAssigned,
      chapters_with_audio: chaptersWithAudio,
    };
  }

  private async requireOwnedChapter(userId: string, chapterId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('chapters')
      .select('id')
      .eq('id', chapterId)
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Chapter not found');
    return data;
  }
}
