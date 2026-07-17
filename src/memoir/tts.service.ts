import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sanitizeHtml from 'sanitize-html';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';

const DEFAULT_VOICE = 'aura-2-thalia-en';

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
    private readonly config: ConfigService,
  ) {}

  async generateTts(
    userId: string,
    chapterId: string,
    ttsId: string,
    voiceModel: string,
  ) {
    const supabase = this.supabase.getClient();

    await supabase
      .from('chapter_tts')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', ttsId);

    try {
      const { data: chapter } = await supabase
        .from('chapters')
        .select('body')
        .eq('id', chapterId)
        .single();

      if (!chapter?.body) {
        throw new Error('Chapter has no body content');
      }

      const plainText = sanitizeHtml(chapter.body as string, {
        allowedTags: [],
      }).trim();

      if (!plainText) {
        throw new Error('Chapter body is empty after stripping HTML');
      }

      const chunks = this.chunkText(plainText, 2000);
      const audioBuffers: Buffer[] = [];

      const apiKey = this.config.get<string>('DEEPGRAM_API_KEY');
      if (!apiKey) throw new Error('DEEPGRAM_API_KEY not configured');

      for (const chunk of chunks) {
        const response = await fetch(
          `https://api.deepgram.com/v1/speak?model=${voiceModel}&encoding=mp3`,
          {
            method: 'POST',
            headers: {
              Authorization: `Token ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: chunk }),
            signal: AbortSignal.timeout(60_000),
          },
        );

        if (!response.ok) {
          throw new Error(
            `Deepgram TTS failed: ${response.status} ${response.statusText}`,
          );
        }

        const arrayBuffer = await response.arrayBuffer();
        audioBuffers.push(Buffer.from(arrayBuffer));
      }

      const finalBuffer = Buffer.concat(audioBuffers);
      const storagePath = `${userId}/${chapterId}/narration.mp3`;

      const { error: uploadError } = await supabase.storage
        .from('chapter-audio')
        .upload(storagePath, finalBuffer, {
          contentType: 'audio/mpeg',
          upsert: true,
        });

      if (uploadError) throw uploadError;

      const estimatedDuration = (plainText.length / 5 / 150) * 60;

      await supabase
        .from('chapter_tts')
        .update({
          storage_path: storagePath,
          duration_seconds: Math.round(estimatedDuration * 100) / 100,
          file_size_bytes: finalBuffer.length,
          status: 'ready',
          updated_at: new Date().toISOString(),
        })
        .eq('id', ttsId);

      this.activityService
        .log(userId, 'tts_generation_completed', 'Audio narration ready', {
          chapterId,
        })
        .catch(() => null);

      this.posthog.capture(userId, 'tts_generation_completed', {
        chapterId,
        duration_seconds: Math.round(estimatedDuration * 100) / 100,
        file_size_bytes: finalBuffer.length,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Unknown error';

      await supabase
        .from('chapter_tts')
        .update({
          status: 'failed',
          error_message: message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', ttsId);

      this.activityService
        .log(userId, 'tts_generation_failed', 'Audio narration failed', {
          chapterId,
          error: message,
        })
        .catch(() => null);
    }
  }

  chunkText(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];

    const sentences = text.match(/[^.!?]+[.!?]+\s*/g) ?? [text];
    const chunks: string[] = [];
    let current = '';

    for (const sentence of sentences) {
      if (current.length + sentence.length > limit && current.length > 0) {
        chunks.push(current.trim());
        current = '';
      }
      current += sentence;
    }

    if (current.trim()) chunks.push(current.trim());

    return chunks;
  }

  get defaultVoice() {
    return DEFAULT_VOICE;
  }
}
