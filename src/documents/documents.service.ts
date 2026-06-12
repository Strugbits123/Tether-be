import { randomUUID } from 'crypto';
import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { DocumentFileDescriptorDto } from './dto/request-upload-urls.dto.js';
import { AssignmentDto } from './dto/assignment.dto.js';
import { CreateDocumentsBatchDto, DocumentItemDto } from './dto/create-documents-batch.dto.js';

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
};

@Injectable()
export class DocumentsService {
  constructor(private readonly supabase: SupabaseService) {}

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
        })
        .select()
        .single();

      if (error || !created) {
        throw new InternalServerErrorException('Failed to save document record');
      }

      await this.createAssignments(userId, created.id, dto.assignments);

      this.logActivity(userId, created.id, title, category, doc).catch(() => null);

      createdDocuments.push(created);
    }

    return { count: createdDocuments.length, documents: createdDocuments };
  }

  async listDocuments(userId: string, category?: string) {
    let query = this.supabase
      .getClient()
      .from('documents')
      .select('*')
      .eq('user_id', userId);

    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query.order('created_at', {
      ascending: false,
    });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch documents');
    }

    return Promise.all(
      (data ?? []).map(async (doc) => {
        const { data: urlData } = await this.supabase
          .getClient()
          .storage.from('documents')
          .createSignedUrl(doc.storage_path, 3600);
        return { ...doc, signedUrl: urlData?.signedUrl ?? null };
      }),
    );
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
      .single();

    if (error || !data) throw new NotFoundException('Document not found');
    if (data.user_id !== userId)
      throw new ForbiddenException('Not your document');
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

  private async logActivity(
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
