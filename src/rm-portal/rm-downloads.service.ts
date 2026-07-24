import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Archiver, ZipArchive } from 'archiver';
import sanitizeHtml from 'sanitize-html';
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
  const results: R[] = new Array(items.length);
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

  // POST /rm/downloads/prepare — returns the archive stream itself (not a
  // fully-buffered zip) so the controller can pipe it straight to the HTTP
  // response as entries are compressed, rather than holding the whole
  // package in memory before the client sees a single byte.
  async prepareDownload(
    ownerId: string,
    dto: PrepareDownloadDto,
  ): Promise<{ archive: Archiver; filename: string }> {
    await this.assertReleaseInitiated(ownerId);

    const archive = new ZipArchive({ zlib: { level: 9 } });
    const client = this.supabase.getClient();
    let fileCount = 0;

    if (dto.audio !== false) {
      fileCount += await this.addAudioMessages(archive, ownerId, client);
    }
    if (dto.documents !== false) {
      fileCount += await this.addDocuments(archive, ownerId, client);
    }
    if (dto.photos !== false) {
      fileCount += await this.addPhotos(archive, ownerId, client);
    }
    if (dto.transcripts !== false) {
      fileCount += await this.addTranscripts(archive, ownerId, client);
    }
    if (dto.life_story !== false) {
      fileCount += await this.addLifeStory(archive, ownerId);
    }

    this.activityService.log(ownerId, 'content_downloaded', 'Release Manager downloaded content package', {
      fileCount,
    });

    return { archive, filename: 'Tether-Content.zip' };
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
  ): Promise<number> {
    const assignedIds = await this.getAssignedContentIds(ownerId, 'message');
    if (assignedIds.size === 0) return 0;

    const { data: messages } = await client
      .from('messages')
      .select('id, title, storage_path, mime_type')
      .eq('user_id', ownerId)
      .eq('type', 'audio')
      .in('id', [...assignedIds]);

    const results = await mapWithConcurrency(messages ?? [], DOWNLOAD_CONCURRENCY, async (m) => {
      if (!m.storage_path) return false;
      const buffer = await this.downloadFromBucket(client, 'audio', m.storage_path);
      if (!buffer) return false;
      const ext = extFromPath(m.storage_path);
      archive.append(buffer, { name: `Audio Messages/${sanitizeFileName(m.title || 'Untitled')}.${ext}` });
      return true;
    });
    return results.filter(Boolean).length;
  }

  private async addDocuments(
    archive: Archiver,
    ownerId: string,
    client: ReturnType<SupabaseService['getClient']>,
  ): Promise<number> {
    const assignedIds = await this.getAssignedContentIds(ownerId, 'document');
    if (assignedIds.size === 0) return 0;

    const { data: documents } = await client
      .from('documents')
      .select('id, title, original_filename, storage_path')
      .eq('user_id', ownerId)
      .in('id', [...assignedIds]);

    const results = await mapWithConcurrency(documents ?? [], DOWNLOAD_CONCURRENCY, async (d) => {
      if (!d.storage_path) return false;
      const buffer = await this.downloadFromBucket(client, 'documents', d.storage_path);
      if (!buffer) return false;
      const ext = extFromPath(d.original_filename || d.storage_path);
      const baseName = d.original_filename
        ? sanitizeFileName(d.original_filename)
        : `${sanitizeFileName(d.title || 'Untitled')}.${ext}`;
      archive.append(buffer, { name: `Documents/${baseName}` });
      return true;
    });
    return results.filter(Boolean).length;
  }

  private async addPhotos(
    archive: Archiver,
    ownerId: string,
    client: ReturnType<SupabaseService['getClient']>,
  ): Promise<number> {
    const assignedIds = await this.getAssignedContentIds(ownerId, 'photo');
    if (assignedIds.size === 0) return 0;

    const { data: photos } = await client
      .from('photos')
      .select('id, title, storage_path')
      .eq('user_id', ownerId)
      .in('id', [...assignedIds]);

    const results = await mapWithConcurrency(photos ?? [], DOWNLOAD_CONCURRENCY, async (p, i) => {
      if (!p.storage_path) return false;
      // Full-resolution original — never the compressed variant.
      const buffer = await this.downloadFromBucket(client, 'photos', p.storage_path);
      if (!buffer) return false;
      const ext = extFromPath(p.storage_path);
      archive.append(buffer, { name: `Photos/${sanitizeFileName(p.title || `Photo-${i + 1}`)}.${ext}` });
      return true;
    });
    return results.filter(Boolean).length;
  }

  private async addTranscripts(
    archive: Archiver,
    ownerId: string,
    client: ReturnType<SupabaseService['getClient']>,
  ): Promise<number> {
    const assignedIds = await this.getAssignedContentIds(ownerId, 'message');
    if (assignedIds.size === 0) return 0;

    const { data: messages } = await client
      .from('messages')
      .select('id, title, type, transcript, created_at')
      .eq('user_id', ownerId)
      .in('id', [...assignedIds]);

    const results = await mapWithConcurrency(messages ?? [], DOWNLOAD_CONCURRENCY, async (m) => {
      if (!m.transcript || !m.transcript.trim()) return false;
      const html = this.buildTranscriptHtml(m.title || 'Untitled Message', m.type, m.transcript);
      const buffer = await this.pdfService.generatePdfFromHtml(html);
      archive.append(buffer, { name: `Transcripts/${sanitizeFileName(m.title || 'Untitled Message')}.pdf` });
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

  private async addLifeStory(archive: Archiver, ownerId: string): Promise<number> {
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
    const { buffer } = await this.pdfService.generatePdf({
      title: memoir?.title ?? null,
      dedication: memoir?.dedication ?? null,
      chapters: chapters.map((c) => ({
        title: c.title,
        date_label: c.date_label,
        theme: c.theme,
        body: c.body,
      })),
    });
    archive.append(buffer, { name: 'Life Story.pdf' });
    return chapters.length;
  }
}
