import { randomUUID } from 'crypto';
import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { DocumentFileDescriptorDto } from './dto/request-upload-urls.dto.js';
import { AssignmentDto } from './dto/assignment.dto.js';
import {
  CreateDocumentsBatchDto,
  DocumentItemDto,
} from './dto/create-documents-batch.dto.js';
import { UpdateDocumentDto } from './dto/update-document.dto.js';

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'docx',
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

@Injectable()
export class DocumentsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
  ) {}

  async getUploadUrls(userId: string, files: DocumentFileDescriptorDto[]) {
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
    const createdDocuments: Record<string, unknown>[] = [];

    for (const doc of dto.documents) {
      const title = doc.title ?? doc.originalFilename.replace(/\.[^.]+$/, '');
      const category = doc.category ?? 'personal';

      const { data: created, error } = await this.supabase
        .getClient()
        .from('documents')
        .insert({
          user_id: userId,
          title,
          category,
          note: dto.note ?? null,
          original_filename: doc.originalFilename,
          storage_path: doc.storagePath,
          file_type: doc.fileType,
          file_size_bytes: doc.fileSizeBytes,
          mime_type: doc.mimeType ?? null,
        })
        .select()
        .single();

      if (error || !created) {
        throw new InternalServerErrorException(
          'Failed to save document record',
        );
      }

      await this.createAssignments(userId, created.id, dto.assignments);

      this.logUploadActivity(userId, created.id, title, category, doc).catch(
        () => null,
      );

      createdDocuments.push(created);
    }

    this.posthog.capture(userId, 'server_documents_uploaded', {
      count: createdDocuments.length,
      categories: createdDocuments.map(
        (d) => (d as Record<string, unknown>).category,
      ),
    });

    // Mark create_message onboarding step when audio/video is uploaded,
    // since these replace the old messages audio/video upload flow.
    const hasMedia = dto.documents.some((d) => {
      const mime = d.mimeType ?? '';
      return mime.startsWith('audio/') || mime.startsWith('video/');
    });
    if (hasMedia) {
      this.markOnboardingStep(userId, 'create_message').catch(() => null);
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
      query = query.in('mime_type', [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ]);
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
    const { data: assignments } = await this.supabase
      .getClient()
      .from('content_assignments')
      .select('content_id, assignment_scope, group_value, recipient_id')
      .eq('content_type', 'document')
      .in('content_id', docIds);

    const assignmentMap = new Map<string, number>();
    for (const a of assignments ?? []) {
      assignmentMap.set(
        a.content_id,
        (assignmentMap.get(a.content_id) ?? 0) + 1,
      );
    }

    const { data: urlResults } = await this.supabase
      .getClient()
      .storage.from('documents')
      .createSignedUrls(
        docs.map((d) => d.storage_path),
        3600,
      );

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

    const { data: urlData } = await this.supabase
      .getClient()
      .storage.from('documents')
      .createSignedUrl(doc.storage_path, 3600);

    const { data: assignments } = await this.supabase
      .getClient()
      .from('content_assignments')
      .select('assignment_scope, group_value, recipient_id')
      .eq('content_type', 'document')
      .eq('content_id', documentId);

    return {
      ...doc,
      signedUrl: urlData?.signedUrl ?? null,
      assignments: assignments ?? [],
    };
  }

  async updateDocument(
    userId: string,
    documentId: string,
    dto: UpdateDocumentDto,
  ) {
    const doc = await this.requireOwnedDocument(userId, documentId);

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

    if (dto.assignments !== undefined) {
      await this.supabase
        .getClient()
        .from('content_assignments')
        .delete()
        .eq('content_type', 'document')
        .eq('content_id', documentId);

      await this.createAssignments(userId, documentId, dto.assignments);
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

    return { message: 'Document deleted' };
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

  private async createAssignments(
    userId: string,
    documentId: string,
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
          content_type: 'document',
          content_id: documentId,
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

  private async markOnboardingStep(userId: string, step: string) {
    const { data } = await this.supabase
      .getClient()
      .from('users')
      .select('onboarding')
      .eq('id', userId)
      .single();

    const onboarding = ((data?.onboarding ?? {}) as Record<string, unknown>);
    if (onboarding[step]) return;

    onboarding[step] = true;

    const ALL_STEPS = [
      'finish_account',
      'add_release_manager',
      'add_recipients',
      'add_photos',
      'create_message',
    ];
    if (ALL_STEPS.every((s) => onboarding[s] === true)) {
      onboarding['completed_at'] = new Date().toISOString();
    }

    await this.supabase
      .getClient()
      .from('users')
      .update({ onboarding, updated_at: new Date().toISOString() })
      .eq('id', userId);
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
