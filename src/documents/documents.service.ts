import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { AnalyticsService } from '../shared/posthog/analytics.service.js';
import { DocumentFileDescriptorDto } from './dto/request-upload-urls.dto.js';
import {
  CreateDocumentsBatchDto,
  DocumentItemDto,
} from './dto/create-documents-batch.dto.js';
import { UpdateDocumentDto } from './dto/update-document.dto.js';

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  // Legacy Word format — a real .doc, not .docx. Mapping it to 'docx' would
  // persist the wrong extension as the document's permanent file_type (the
  // viewer renders file_type verbatim).
  'application/msword': 'doc',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'audio/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/x-m4a': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
  'video/x-msvideo': 'avi',
  'video/mpeg': 'mpeg',
};

const ALL_CATEGORIES = [
  'legal',
  'financial',
  'insurance',
  'medical',
  'property',
  'digital_accounts',
  'personal',
  'military',
  'other',
] as const;

// Bucketed file size for analytics — avoids sending exact byte counts while
// still allowing size-distribution segmentation.
function sizeBucket(bytes: number): string {
  if (bytes < 1_048_576) return 'under_1mb'; // < 1MB
  if (bytes < 5_242_880) return '1_5mb'; // 1–5MB
  if (bytes < 26_214_400) return '5_25mb'; // 5–25MB
  return 'over_25mb';
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
    private readonly analytics: AnalyticsService,
  ) {}

  async getUploadUrls(userId: string, files: DocumentFileDescriptorDto[]) {
    // Server-side validation runs BEFORE any presigned URL is issued.
    // Audio/video may be stored as documents up to 50MB; all other document
    // types (PDF, DOCX, images) are capped at 25MB.
    const NON_AV_MAX_BYTES = 26214400; // 25MB
    const AV_MAX_BYTES = 52428800; // 50MB
    for (const file of files) {
      if (!(file.fileType in MIME_TO_EXT)) {
        throw new BadRequestException('File type not supported');
      }
      const isAv =
        file.fileType.startsWith('audio/') ||
        file.fileType.startsWith('video/');
      if (!isAv && file.fileSizeBytes > NON_AV_MAX_BYTES) {
        throw new BadRequestException('File exceeds 25MB limit');
      }
      if (isAv && file.fileSizeBytes > AV_MAX_BYTES) {
        throw new BadRequestException('File exceeds 50MB limit');
      }
    }

    const results: {
      signedUploadUrl: string;
      token: string;
      storagePath: string;
      fileIndex: number;
    }[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = MIME_TO_EXT[file.fileType] ?? 'bin';
      const storagePath = `${userId}/${randomUUID()}.${ext}`;

      const { data, error } = await this.supabase
        .getClient()
        .storage.from('documents')
        .createSignedUploadUrl(storagePath);

      if (error) {
        throw new InternalServerErrorException(
          `Failed to generate upload URL for file ${i}`,
        );
      }

      results.push({
        signedUploadUrl: data.signedUrl,
        token: data.token,
        storagePath,
        fileIndex: i,
      });
    }

    return results;
  }

  async createBatch(userId: string, dto: CreateDocumentsBatchDto) {
    const effective =
      dto.assignments.length > 0 ? dto.assignments : [{ scope: 'assign_later' }];

    // Authorize recipients BEFORE any write, so a cross-tenant assignment can't
    // create orphaned document rows before returning 403.
    await this.assertRecipientsOwned(
      userId,
      effective
        .filter((a) => a.scope === 'individual' && a.recipientId)
        .map((a) => a.recipientId as string),
    );

    const documentsPayload = dto.documents.map((doc) => ({
      title: doc.title ?? doc.originalFilename.replace(/\.[^.]+$/, ''),
      category: doc.category ?? 'other',
      original_filename: doc.originalFilename,
      storage_path: doc.storagePath,
      file_type: doc.fileType,
      file_size_bytes: doc.fileSizeBytes,
      mime_type: doc.mimeType ?? null,
    }));
    const assignmentRows = effective.map((a) => ({
      assignment_scope: a.scope,
      group_value: a.scope === 'group' ? (a.groupValue ?? null) : null,
      recipient_id: a.scope === 'individual' ? (a.recipientId ?? null) : null,
    }));

    // Insert all documents + their assignments in a single transaction so a
    // partial failure can't leave orphaned/partly-committed rows.
    const { data, error } = await this.supabase
      .getClient()
      .rpc('create_documents_with_assignments', {
        p_user_id: userId,
        p_documents: documentsPayload,
        p_assignments: assignmentRows,
        p_note: dto.note ?? null,
      });

    if (error || !data) {
      throw new InternalServerErrorException('Failed to save documents');
    }

    const createdDocuments = data as Record<string, any>[];
    const byPath = new Map(
      createdDocuments.map((d) => [d.storage_path as string, d]),
    );

    for (const doc of dto.documents) {
      const created = byPath.get(doc.storagePath);
      if (!created) continue;
      this.logUploadActivity(
        userId,
        created.id as string,
        (created.title as string) ?? doc.originalFilename,
        (created.category as string) ?? 'other',
        doc,
      ).catch(() => null);

      // Metadata only — never filename or content.
      this.posthog.capture(userId, 'document_secured', {
        category: created.category ?? 'other',
        file_type: doc.fileType,
        size_bucket: sizeBucket(doc.fileSizeBytes),
        file_size_kb: Math.round((doc.fileSizeBytes ?? 0) / 1024),
        recipient_count: effective.filter(
          (a) => a.scope === 'individual' && a.recipientId,
        ).length,
      });
    }

    // Fire document_assigned once for the batch on an explicit assignment.
    if (dto.assignments.some((a) => a.scope !== 'assign_later')) {
      this.posthog.capture(userId, 'document_assigned', {
        recipient_count: dto.assignments.filter((a) => a.scope === 'individual')
          .length,
      });
    }

    // Mark create_message onboarding step when audio/video is uploaded,
    // since these replace the old messages audio/video upload flow.
    const hasMedia = dto.documents.some((d) => {
      const mime = d.mimeType ?? '';
      return mime.startsWith('audio/') || mime.startsWith('video/');
    });
    if (hasMedia) {
      this.analytics
        .markOnboardingStep(userId, 'create_message')
        .catch(() => null);
    }

    return { count: createdDocuments.length, documents: createdDocuments };
  }

  async getStats(userId: string) {
    const { data: categoryRows, error: catError } = await this.supabase
      .getClient()
      .from('documents')
      .select('category')
      .eq('user_id', userId);

    if (catError) {
      throw new InternalServerErrorException('Failed to fetch document stats');
    }

    const categoryCounts: Record<string, number> = Object.fromEntries(
      ALL_CATEGORIES.map((c) => [c, 0]),
    );
    for (const row of categoryRows ?? []) {
      const cat = row.category as string;
      if (cat in categoryCounts) categoryCounts[cat]++;
      else categoryCounts['other'] = (categoryCounts['other'] ?? 0) + 1;
    }

    const { data: mimeRows, error: mimeError } = await this.supabase
      .getClient()
      .from('documents')
      .select('mime_type')
      .eq('user_id', userId);

    if (mimeError) {
      throw new InternalServerErrorException(
        'Failed to fetch document file type stats',
      );
    }

    const fileTypes = {
      total: 0,
      documents: 0,
      audio: 0,
      video: 0,
      images: 0,
      other: 0,
    };
    for (const row of mimeRows ?? []) {
      const mime: string = row.mime_type ?? '';
      fileTypes.total++;
      if (mime.startsWith('application/')) fileTypes.documents++;
      else if (mime.startsWith('audio/')) fileTypes.audio++;
      else if (mime.startsWith('video/')) fileTypes.video++;
      else if (mime.startsWith('image/')) fileTypes.images++;
      else fileTypes.other++;
    }

    return { categories: categoryCounts, fileTypes };
  }

  async listDocuments(userId: string, category?: string, fileType?: string) {
    let query = this.supabase
      .getClient()
      .from('documents')
      .select('*')
      .eq('user_id', userId);

    if (category) {
      query = query.eq('category', category);
    }

    if (fileType === 'documents') {
      // Must stay consistent with getDocumentStats, which counts anything
      // application/* as a document. An explicit allow-list here silently
      // dropped application/msword (.doc): it was counted in the Documents
      // tile, yet returned by neither this filter nor 'other' (which excludes
      // all application/*) — so a .doc was reachable under no filter at all.
      query = (query as any).like('mime_type', 'application/%');
    } else if (fileType === 'audio') {
      query = (query as any).like('mime_type', 'audio/%');
    } else if (fileType === 'video') {
      query = (query as any).like('mime_type', 'video/%');
    } else if (fileType === 'images') {
      query = (query as any).like('mime_type', 'image/%');
    } else if (fileType === 'other') {
      query = query
        .not('mime_type', 'like', 'application/%')
        .not('mime_type', 'like', 'audio/%')
        .not('mime_type', 'like', 'video/%')
        .not('mime_type', 'like', 'image/%');
    }

    const { data, error } = await query.order('created_at', {
      ascending: false,
    });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch documents');
    }

    const docs = data ?? [];

    if (docs.length === 0) return [];

    const docIds = docs.map((d) => d.id);
    const { data: assignments, error: assignmentsError } = await this.supabase
      .getClient()
      .from('content_assignments')
      .select('content_id, assignment_scope, group_value, recipient_id')
      .eq('content_type', 'document')
      .in('content_id', docIds);

    // Surface a failure instead of silently reporting assignmentCount: 0.
    if (assignmentsError) {
      throw new InternalServerErrorException('Failed to fetch assignments');
    }

    const assignmentMap = new Map<string, number>();
    for (const a of assignments ?? []) {
      assignmentMap.set(
        a.content_id,
        (assignmentMap.get(a.content_id) ?? 0) + 1,
      );
    }

    const { data: urlResults, error: urlError } = await this.supabase
      .getClient()
      .storage.from('documents')
      .createSignedUrls(
        docs.map((d) => d.storage_path),
        3600,
      );

    // Surface a signing failure rather than returning null URLs as valid state.
    if (urlError) {
      throw new InternalServerErrorException('Failed to generate document URLs');
    }

    const urlMap = new Map(
      (urlResults ?? []).map((r) => [r.path, r.signedUrl]),
    );

    return docs.map((doc) => ({
      ...doc,
      signedUrl: urlMap.get(doc.storage_path) ?? null,
      assignmentCount: assignmentMap.get(doc.id) ?? 0,
    }));
  }

  async getDocument(userId: string, documentId: string) {
    const doc = await this.requireOwnedDocument(userId, documentId);

    const { data: urlData, error: urlError } = await this.supabase
      .getClient()
      .storage.from('documents')
      .createSignedUrl(doc.storage_path, 3600);

    if (urlError || !urlData) {
      throw new InternalServerErrorException('Failed to generate document URL');
    }

    const { data: assignments, error: assignmentsError } = await this.supabase
      .getClient()
      .from('content_assignments')
      .select('assignment_scope, group_value, recipient_id')
      .eq('content_type', 'document')
      .eq('content_id', documentId);

    if (assignmentsError) {
      throw new InternalServerErrorException('Failed to fetch assignments');
    }

    return {
      ...doc,
      signedUrl: urlData.signedUrl,
      assignments: assignments ?? [],
    };
  }

  async updateDocument(
    userId: string,
    documentId: string,
    dto: UpdateDocumentDto,
  ) {
    const doc = await this.requireOwnedDocument(userId, documentId);

    // Authorize recipients BEFORE any mutation, so a cross-tenant recipient
    // can't change the title/note/category and then fail with 403.
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
    if (dto.note !== undefined) updates.note = dto.note;
    if (dto.category !== undefined) updates.category = dto.category;

    const { data: updated, error: updateError } = await this.supabase
      .getClient()
      .from('documents')
      .update(updates)
      .eq('id', documentId)
      .select()
      .single();

    if (updateError || !updated) {
      throw new InternalServerErrorException('Failed to update document');
    }

    if (assignmentRows !== null) {
      // Transactional replace: delete + insert in one RPC so a failed insert
      // can't permanently leave the document unassigned.
      const { error: replaceError } = await this.supabase
        .getClient()
        .rpc('replace_content_assignments', {
          p_user_id: userId,
          p_content_type: 'document',
          p_content_id: documentId,
          p_rows: assignmentRows,
        });
      if (replaceError) {
        throw new InternalServerErrorException('Failed to update assignments');
      }
    }

    if (dto.category !== undefined && dto.category !== doc.category) {
      this.activityService
        .log(
          userId,
          'document_updated',
          `Document category changed to ${dto.category}`,
          {
            documentId,
            oldCategory: doc.category,
            newCategory: dto.category,
          },
        )
        .catch(() => null);
    }

    return updated;
  }

  async getDownloadUrl(userId: string, documentId: string) {
    const doc = await this.requireOwnedDocument(userId, documentId);

    const { data, error } = await this.supabase
      .getClient()
      .storage.from('documents')
      .createSignedUrl(doc.storage_path, 900, {
        download: doc.original_filename,
      });

    if (error || !data) {
      throw new InternalServerErrorException('Failed to generate download URL');
    }

    return {
      downloadUrl: data.signedUrl,
      expiresIn: 900,
      filename: doc.original_filename,
    };
  }

  async deleteDocument(userId: string, documentId: string) {
    const doc = await this.requireOwnedDocument(userId, documentId);

    await this.supabase
      .getClient()
      .storage.from('documents')
      .remove([doc.storage_path]);

    const { error } = await this.supabase
      .getClient()
      .from('documents')
      .delete()
      .eq('id', documentId);

    if (error) {
      throw new InternalServerErrorException('Failed to delete document');
    }

    this.posthog.capture(userId, 'document_deleted', {
      age_days: this.ageDays(doc.created_at as string | null),
    });

    return { message: 'Document deleted' };
  }

  // Whole days between a row's creation and now, for lifecycle analytics.
  private ageDays(createdAt: string | null): number | null {
    if (!createdAt) return null;
    const created = new Date(createdAt).getTime();
    if (Number.isNaN(created)) return null;
    return Math.max(0, Math.floor((Date.now() - created) / 86_400_000));
  }

  private async requireOwnedDocument(userId: string, documentId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Document not found');
    return data;
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

  private async logUploadActivity(
    userId: string,
    documentId: string,
    title: string,
    category: string,
    doc: DocumentItemDto,
  ) {
    await this.supabase
      .getClient()
      .from('activity_log')
      .insert({
        user_id: userId,
        event_type: 'document_uploaded',
        event_label: `${title} uploaded`,
        metadata: {
          documentId,
          category,
          fileType: doc.fileType,
          fileSize: doc.fileSizeBytes,
          originalFilename: doc.originalFilename,
        },
      });
  }
}
