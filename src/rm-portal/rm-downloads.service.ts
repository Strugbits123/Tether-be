import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Archiver, ZipArchive } from 'archiver';
import sanitizeHtml from 'sanitize-html';
import Mux from '@mux/mux-node';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { PdfService } from '../memoir/pdf.service.js';
import { PrepareDownloadDto } from './dto/prepare-download.dto.js';

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 ._-]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 150) : 'file';
}

function extFromPath(path: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(path);
  return match ? match[1] : 'bin';
}

// Runs `fn` over `items` with at most `limit` in flight at once — per-file
// downloads/PDF generation were previously fully sequential, which serializes
// I/O that could otherwise overlap.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const DOWNLOAD_CONCURRENCY = 5;

@Injectable()
export class RmDownloadsService {
  private readonly logger = new Logger(RmDownloadsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly activityService: ActivityService,
    private readonly pdfService: PdfService,
    private readonly config: ConfigService,
  ) {}

  // Content only becomes downloadable once the account owner's release has
  // actually been initiated — matches the invitation-email promise that the
  // RM has no content access beforehand.
  private async assertReleaseInitiated(ownerId: string): Promise<void> {
    const { data } = await this.supabase
      .getClient()
      .from('release_plans')
      .select('id')
      .eq('user_id', ownerId)
      .in('status', ['active', 'paused', 'delivered'])
      .limit(1)
      .maybeSingle();

    if (!data) {
      throw new ForbiddenException(
        'Content becomes available for download once the release has been initiated.',
      );
    }
  }

  // Only content actually assigned for delivery (individual/group/all/
  // release_manager scope) is in scope here — draft/"assign later" content
  // never reaches a recipient and must never be downloadable by the RM.
  private async getAssignedContentIds(
    ownerId: string,
    contentType: string,
  ): Promise<Set<string>> {
    const { data, error } = await this.supabase
      .getClient()
      .from('content_assignments')
      .select('content_id, assignment_scope')
      .eq('user_id', ownerId)
      .eq('content_type', contentType)
      .neq('assignment_scope', 'assign_later');

    if (error) {
      throw new InternalServerErrorException('Failed to resolve assigned content.');
    }

    return new Set((data ?? []).map((a) => a.content_id));
  }

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

  // GET /rm/downloads/videos
  //
  // Video messages live in Mux, not Supabase Storage, so they can't be added to
  // the content ZIP the way audio/photos/documents are — hence a separate page
  // that downloads them one at a time.
  //
  // Downloading a Mux asset requires a *static rendition* ('highest.mp4'); Mux
  // exposes no downloadable file otherwise. New uploads request one at creation
  // (MessagesService.createVideoUploadUrl), but assets predating that have none,
  // so this enables it lazily on first listing and reports 'preparing' until
  // Mux finishes transcoding. Nothing here blocks on that.
  async listVideos(ownerId: string) {
    await this.assertReleaseInitiated(ownerId);

    const assignedIds = await this.getAssignedContentIds(ownerId, 'message');
    if (assignedIds.size === 0) return { videos: [] };

    const { data: messages, error } = await this.supabase
      .getClient()
      .from('messages')
      .select('id, title, mux_asset_id, mux_playback_id, duration_seconds, created_at')
      .eq('user_id', ownerId)
      .eq('type', 'video')
      .in('id', [...assignedIds])
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch video messages.');
    }

    const ready = (messages ?? []).filter((m) => m.mux_asset_id && m.mux_playback_id);
    if (ready.length === 0) return { videos: [] };

    const mux = this.getMuxClient();

    const videos = await mapWithConcurrency(ready, DOWNLOAD_CONCURRENCY, async (m) => {
      const playbackId = m.mux_playback_id as string;
      const title = m.title || 'Untitled video';

      // Signed playback policy: both the thumbnail and the MP4 need a JWT.
      // 'thumbnail' → aud 't', 'video' → aud 'v'; per Mux's static-rendition
      // guide the MP4 uses the same signing as normal playback.
      let thumbnailUrl: string | null = null;
      let downloadToken: string | null = null;
      try {
        const [thumbToken, videoToken] = await Promise.all([
          mux.jwt.signPlaybackId(playbackId, { type: 'thumbnail', expiration: '1h' }),
          mux.jwt.signPlaybackId(playbackId, { type: 'video', expiration: '1h' }),
        ]);
        thumbnailUrl = `https://image.mux.com/${playbackId}/thumbnail.jpg?token=${thumbToken}`;
        downloadToken = videoToken;
      } catch (err) {
        this.logger.error(`Failed to sign Mux tokens for message ${m.id}`, err);
      }

      let status: 'ready' | 'preparing' | 'errored' = 'preparing';
      let fileSizeBytes: number | null = null;

      try {
        const asset = await mux.video.assets.retrieve(m.mux_asset_id as string);
        const files = asset.static_renditions?.files ?? [];
        const mp4 = files.find((f) => f.name === 'highest.mp4');

        if (!mp4) {
          // No rendition requested for this asset yet — request one now. Safe to
          // attempt repeatedly: a duplicate request is rejected and swallowed,
          // and the next poll will see it as 'preparing'.
          try {
            await mux.video.assets.createStaticRendition(m.mux_asset_id as string, {
              resolution: 'highest',
            });
          } catch (err) {
            this.logger.warn(
              `Could not request a static rendition for asset ${m.mux_asset_id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        } else if (mp4.status === 'ready') {
          status = 'ready';
          fileSizeBytes = mp4.filesize ? Number(mp4.filesize) : null;
        } else if (mp4.status === 'errored' || mp4.status === 'skipped') {
          status = 'errored';
        }
      } catch (err) {
        this.logger.error(`Failed to read Mux asset for message ${m.id}`, err);
        status = 'errored';
      }

      // ?download= makes the browser save rather than navigate. It matters
      // because the file is cross-origin, where the anchor `download`
      // attribute is ignored.
      const downloadUrl =
        status === 'ready' && downloadToken
          ? `https://stream.mux.com/${playbackId}/highest.mp4?download=${encodeURIComponent(
              sanitizeFileName(title),
            )}&token=${downloadToken}`
          : null;

      return {
        id: m.id,
        title,
        duration_seconds: m.duration_seconds ?? null,
        created_at: m.created_at,
        thumbnail_url: thumbnailUrl,
        download_url: downloadUrl,
        file_size_bytes: fileSizeBytes,
        status,
      };
    });

    return { videos };
  }

  // GET /rm/downloads/summary
  async getSummary(ownerId: string) {
    await this.assertReleaseInitiated(ownerId);

    const [assignedMessageIds, assignedDocumentIds, assignedPhotoIds, assignedChapterIds] =
      await Promise.all([
        this.getAssignedContentIds(ownerId, 'message'),
        this.getAssignedContentIds(ownerId, 'document'),
        this.getAssignedContentIds(ownerId, 'photo'),
        this.getAssignedContentIds(ownerId, 'chapter'),
      ]);

    const client = this.supabase.getClient();

    const [{ data: messages }, { data: chapters }] = await Promise.all([
      client
        .from('messages')
        .select('id, type, transcript')
        .eq('user_id', ownerId)
        .in('id', assignedMessageIds.size ? [...assignedMessageIds] : ['00000000-0000-0000-0000-000000000000']),
      client
        .from('chapters')
        .select('id, status')
        .eq('user_id', ownerId)
        .neq('status', 'draft')
        .in('id', assignedChapterIds.size ? [...assignedChapterIds] : ['00000000-0000-0000-0000-000000000000']),
    ]);

    const audioCount = (messages ?? []).filter((m) => m.type === 'audio').length;
    const transcriptCount = (messages ?? []).filter(
      (m) => typeof m.transcript === 'string' && m.transcript.trim().length > 0,
    ).length;

    return {
      audio_messages: { count: audioCount },
      documents: { count: assignedDocumentIds.size },
      photos: { count: assignedPhotoIds.size },
      transcripts: { count: transcriptCount },
      life_story: { count: chapters?.length ?? 0 },
    };
  }

  // POST /rm/downloads/prepare — hands back the archive plus a `populate`
  // callback rather than a finished zip. The controller pipes the archive to
  // the response *first* and only then awaits populate(), so entries stream out
  // as they're compressed. Appending everything here before returning would
  // buffer the whole package (all audio, photos, documents, PDFs) in memory
  // with nothing draining it — an OOM/latency risk on a large account.
  async prepareDownload(
    ownerId: string,
    dto: PrepareDownloadDto,
  ): Promise<{
    archive: Archiver;
    filename: string;
    populate: () => Promise<void>;
  }> {
    await this.assertReleaseInitiated(ownerId);

    const archive = new ZipArchive({ zlib: { level: 9 } });
    const client = this.supabase.getClient();

    const populate = async () => {
      // Per-folder name allocator: entry names derive from user-controlled
      // titles, so two items sharing a title would otherwise write identical
      // paths and most extractors keep only one — losing content from the
      // handoff package while fileCount still reported both.
      const usedNames = new Set<string>();
      const uniqueName = (name: string): string => {
        if (!usedNames.has(name)) {
          usedNames.add(name);
          return name;
        }
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        for (let n = 2; ; n++) {
          const candidate = `${stem}-${n}${ext}`;
          if (!usedNames.has(candidate)) {
            usedNames.add(candidate);
            return candidate;
          }
        }
      };

      let fileCount = 0;
      if (dto.audio !== false) {
        fileCount += await this.addAudioMessages(archive, ownerId, client, uniqueName);
      }
      if (dto.documents !== false) {
        fileCount += await this.addDocuments(archive, ownerId, client, uniqueName);
      }
      if (dto.photos !== false) {
        fileCount += await this.addPhotos(archive, ownerId, client, uniqueName);
      }
      if (dto.transcripts !== false) {
        fileCount += await this.addTranscripts(archive, ownerId, client, uniqueName);
      }
      if (dto.life_story !== false) {
        fileCount += await this.addLifeStory(archive, ownerId, uniqueName);
      }

      // Logged only after every entry is appended — previously this recorded a
      // successful download before a single byte had reached the client.
      this.activityService.log(ownerId, 'content_downloaded', 'Release Manager downloaded content package', {
        fileCount,
      });
    };

    return { archive, filename: 'Tether-Content.zip', populate };
  }

  private async downloadFromBucket(
    client: ReturnType<SupabaseService['getClient']>,
    bucket: string,
    path: string,
  ): Promise<Buffer | null> {
    const { data, error } = await client.storage.from(bucket).download(path);
    if (error || !data) {
      this.logger.error(`Failed to download ${bucket}/${path}: ${error?.message}`);
      return null;
    }
    return Buffer.from(await data.arrayBuffer());
  }

  private async addAudioMessages(
    archive: Archiver,
    ownerId: string,
    client: ReturnType<SupabaseService['getClient']>,
    uniqueName: (name: string) => string,
  ): Promise<number> {
    const assignedIds = await this.getAssignedContentIds(ownerId, 'message');
    if (assignedIds.size === 0) return 0;

    const { data: messages, error: messagesError } = await client
      .from('messages')
      .select('id, title, storage_path, mime_type')
      .eq('user_id', ownerId)
      .eq('type', 'audio')
      .in('id', [...assignedIds]);

    // Surfaced like getAssignedContentIds: swallowing this would omit the whole
    // category and hand the RM an incomplete package that looks successful.
    if (messagesError) {
      throw new InternalServerErrorException('Failed to fetch audio messages for download.');
    }

    const results = await mapWithConcurrency(messages ?? [], DOWNLOAD_CONCURRENCY, async (m) => {
      if (!m.storage_path) return false;
      const buffer = await this.downloadFromBucket(client, 'audio', m.storage_path);
      if (!buffer) return false;
      const ext = extFromPath(m.storage_path);
      archive.append(buffer, {
        name: uniqueName(`Audio Messages/${sanitizeFileName(m.title || 'Untitled')}.${ext}`),
      });
      return true;
    });
    return results.filter(Boolean).length;
  }

  private async addDocuments(
    archive: Archiver,
    ownerId: string,
    client: ReturnType<SupabaseService['getClient']>,
    uniqueName: (name: string) => string,
  ): Promise<number> {
    const assignedIds = await this.getAssignedContentIds(ownerId, 'document');
    if (assignedIds.size === 0) return 0;

    const { data: documents, error: documentsError } = await client
      .from('documents')
      .select('id, title, original_filename, storage_path')
      .eq('user_id', ownerId)
      .in('id', [...assignedIds]);

    if (documentsError) {
      throw new InternalServerErrorException('Failed to fetch documents for download.');
    }

    const results = await mapWithConcurrency(documents ?? [], DOWNLOAD_CONCURRENCY, async (d) => {
      if (!d.storage_path) return false;
      const buffer = await this.downloadFromBucket(client, 'documents', d.storage_path);
      if (!buffer) return false;
      const ext = extFromPath(d.original_filename || d.storage_path);
      const baseName = d.original_filename
        ? sanitizeFileName(d.original_filename)
        : `${sanitizeFileName(d.title || 'Untitled')}.${ext}`;
      archive.append(buffer, { name: uniqueName(`Documents/${baseName}`) });
      return true;
    });
    return results.filter(Boolean).length;
  }

  private async addPhotos(
    archive: Archiver,
    ownerId: string,
    client: ReturnType<SupabaseService['getClient']>,
    uniqueName: (name: string) => string,
  ): Promise<number> {
    const assignedIds = await this.getAssignedContentIds(ownerId, 'photo');
    if (assignedIds.size === 0) return 0;

    const { data: photos, error: photosError } = await client
      .from('photos')
      .select('id, title, storage_path')
      .eq('user_id', ownerId)
      .in('id', [...assignedIds]);

    if (photosError) {
      throw new InternalServerErrorException('Failed to fetch photos for download.');
    }

    const results = await mapWithConcurrency(photos ?? [], DOWNLOAD_CONCURRENCY, async (p, i) => {
      if (!p.storage_path) return false;
      // Full-resolution original — never the compressed variant.
      const buffer = await this.downloadFromBucket(client, 'photos', p.storage_path);
      if (!buffer) return false;
      const ext = extFromPath(p.storage_path);
      archive.append(buffer, {
        name: uniqueName(`Photos/${sanitizeFileName(p.title || `Photo-${i + 1}`)}.${ext}`),
      });
      return true;
    });
    return results.filter(Boolean).length;
  }

  private async addTranscripts(
    archive: Archiver,
    ownerId: string,
    client: ReturnType<SupabaseService['getClient']>,
    uniqueName: (name: string) => string,
  ): Promise<number> {
    const assignedIds = await this.getAssignedContentIds(ownerId, 'message');
    if (assignedIds.size === 0) return 0;

    const { data: messages, error: transcriptsError } = await client
      .from('messages')
      .select('id, title, type, transcript, created_at')
      .eq('user_id', ownerId)
      .in('id', [...assignedIds]);

    if (transcriptsError) {
      throw new InternalServerErrorException('Failed to fetch transcripts for download.');
    }

    const results = await mapWithConcurrency(messages ?? [], DOWNLOAD_CONCURRENCY, async (m) => {
      if (!m.transcript || !m.transcript.trim()) return false;
      const html = this.buildTranscriptHtml(m.title || 'Untitled Message', m.type, m.transcript);

      // PDF rendering is the only step here that depends on Chromium, and it is
      // by far the most failure-prone (launch timeouts, sandbox issues, memory).
      // Skip the individual transcript rather than letting it throw: this runs
      // while the archive is already streaming to the client, so an exception
      // would truncate the ZIP mid-write and hand the user a file that looks
      // complete but has no central directory ("invalid archive").
      let buffer: Buffer;
      try {
        buffer = await this.pdfService.generatePdfFromHtml(html);
      } catch (err) {
        this.logger.error(
          `Skipping transcript PDF for message ${m.id} — PDF generation failed`,
          err instanceof Error ? err.stack : err,
        );
        return false;
      }

      archive.append(buffer, {
        name: uniqueName(`Transcripts/${sanitizeFileName(m.title || 'Untitled Message')}.pdf`),
      });
      return true;
    });
    return results.filter(Boolean).length;
  }

  private buildTranscriptHtml(title: string, type: string, transcript: string): string {
    const esc = (v: string) => sanitizeHtml(v, { allowedTags: [] });
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:sans-serif;color:#222;line-height:1.6;padding:2em}
h1{font-size:1.4em}
.meta{color:#888;font-size:0.9em;margin-bottom:1.5em;text-transform:uppercase}
p{white-space:pre-wrap}
</style></head><body>
<h1>${esc(title)}</h1>
<p class="meta">${esc(type)} message transcript</p>
<p>${esc(transcript)}</p>
</body></html>`;
  }

  private async addLifeStory(
    archive: Archiver,
    ownerId: string,
    uniqueName: (name: string) => string,
  ): Promise<number> {
    const assignedChapterIds = await this.getAssignedContentIds(ownerId, 'chapter');
    if (assignedChapterIds.size === 0) return 0;

    const client = this.supabase.getClient();

    const [{ data: memoir }, { data: chapterRows }] = await Promise.all([
      client.from('memoirs').select('title, dedication').eq('user_id', ownerId).maybeSingle(),
      client
        .from('chapters')
        .select('id, title, date_label, theme, body, status, display_order')
        .eq('user_id', ownerId)
        .neq('status', 'draft')
        .in('id', [...assignedChapterIds])
        .order('display_order', { ascending: true }),
    ]);

    const chapters = chapterRows ?? [];
    if (chapters.length === 0) return 0;

    // Exhibits are intentionally omitted from the RM's life-story PDF — this
    // package is a text/document handoff, not a re-render of the full memoir
    // builder experience.
    // Same reasoning as addTranscripts: skip rather than throw, because the
    // archive is already streaming and an exception here would truncate it.
    let buffer: Buffer;
    try {
      ({ buffer } = await this.pdfService.generatePdf({
        title: memoir?.title ?? null,
        dedication: memoir?.dedication ?? null,
        chapters: chapters.map((c) => ({
          title: c.title,
          date_label: c.date_label,
          theme: c.theme,
          body: c.body,
        })),
      }));
    } catch (err) {
      this.logger.error(
        `Skipping Life Story PDF for owner ${ownerId} — PDF generation failed`,
        err instanceof Error ? err.stack : err,
      );
      return 0;
    }

    archive.append(buffer, { name: uniqueName('Life Story.pdf') });
    return chapters.length;
  }
}
