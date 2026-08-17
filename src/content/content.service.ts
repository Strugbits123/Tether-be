import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { MessagesService } from '../messages/messages.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { PhotosService } from '../photos/photos.service.js';
import { ChaptersService } from '../chapters/chapters.service.js';
import { AssignmentDto } from '../documents/dto/assignment.dto.js';
import { BulkAssignDto } from './dto/bulk-assign.dto.js';
import { BulkDeleteDto } from './dto/bulk-delete.dto.js';

export interface UnassignedItem {
  id: string;
  contentType: 'message' | 'document' | 'photo' | 'chapter';
  title: string;
  subType: string | null;
  fileSize: number | null;
  createdAt: string;
}

// Maps the public `contentType` to the value stored in
// content_assignments.content_type.
const ASSIGNMENT_TYPE: Record<string, string> = {
  message: 'message',
  document: 'document',
  photo: 'photo',
  chapter: 'chapter',
};

// Maps the public contentType to the table that owns the row, for ownership
// verification before assigning.
const CONTENT_TABLE: Record<string, string> = {
  message: 'messages',
  document: 'documents',
  photo: 'photos',
  chapter: 'chapters',
};

@Injectable()
export class ContentService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly messagesService: MessagesService,
    private readonly documentsService: DocumentsService,
    private readonly photosService: PhotosService,
    private readonly chaptersService: ChaptersService,
  ) {}

  async getUnassigned(userId: string, typeFilter?: string) {
    const supabase = this.supabase.getClient();
    const results: UnassignedItem[] = [];

    // Build the set of content that has at least one "real" (non-assign_later)
    // assignment. Anything not in this set — whether it only has assign_later
    // rows or no rows at all — counts as unassigned.
    const { data: allAssignments } = await supabase
      .from('content_assignments')
      .select('content_type, content_id, assignment_scope')
      .eq('user_id', userId);

    const hasRealAssignment = new Set<string>();
    for (const a of allAssignments ?? []) {
      if (a.assignment_scope !== 'assign_later') {
        hasRealAssignment.add(`${a.content_type}:${a.content_id}`);
      }
    }

    const isUnassigned = (contentType: string, contentId: string) =>
      !hasRealAssignment.has(`${contentType}:${contentId}`);

    // Always scan every content type so `counts` reflects the full unassigned
    // set; `typeFilter` only narrows the returned `items` list (applied below).
    {
      const { data: messages } = await supabase
        .from('messages')
        .select(
          'id, title, type, processing_status, duration_seconds, file_size_bytes, created_at',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      for (const m of messages ?? []) {
        if (isUnassigned('message', m.id)) {
          results.push({
            id: m.id,
            contentType: 'message',
            title: m.title || 'Untitled Message',
            subType: m.type, // 'text' | 'video' | 'audio'
            fileSize: m.file_size_bytes,
            createdAt: m.created_at,
          });
        }
      }
    }

    {
      const { data: docs } = await supabase
        .from('documents')
        .select('id, title, file_type, file_size_bytes, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      for (const d of docs ?? []) {
        if (isUnassigned('document', d.id)) {
          results.push({
            id: d.id,
            contentType: 'document',
            title: d.title || 'Untitled Document',
            subType: d.file_type?.toUpperCase() ?? null, // 'PDF' | 'DOCX' | 'JPG'
            fileSize: d.file_size_bytes,
            createdAt: d.created_at,
          });
        }
      }
    }

    {
      const { data: photos } = await supabase
        .from('photos')
        .select('id, title, storage_path, file_size_bytes, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      for (const p of photos ?? []) {
        if (isUnassigned('photo', p.id)) {
          results.push({
            id: p.id,
            contentType: 'photo',
            title:
              p.title || p.storage_path?.split('/').pop() || 'Untitled Photo',
            subType: null,
            fileSize: p.file_size_bytes,
            createdAt: p.created_at,
          });
        }
      }
    }

    {
      const { data: chapters } = await supabase
        .from('chapters')
        .select('id, title, status, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      for (const c of chapters ?? []) {
        if (isUnassigned('chapter', c.id)) {
          results.push({
            id: c.id,
            contentType: 'chapter',
            title: c.title || 'Untitled Chapter',
            subType: c.status ?? null,
            fileSize: null,
            createdAt: c.created_at,
          });
        }
      }
    }

    results.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    // Counts always reflect the full unassigned set, independent of typeFilter.
    const counts = {
      total: results.length,
      message: results.filter((r) => r.contentType === 'message').length,
      document: results.filter((r) => r.contentType === 'document').length,
      photo: results.filter((r) => r.contentType === 'photo').length,
      chapter: results.filter((r) => r.contentType === 'chapter').length,
    };

    const items = typeFilter
      ? results.filter((r) => r.contentType === typeFilter)
      : results;

    return { items, counts };
  }

  async bulkAssign(userId: string, dto: BulkAssignDto) {
    // Validate content types up front so a bad type can't delete some items'
    // assignments before failing partway through the batch.
    for (const item of dto.items) {
      if (!ASSIGNMENT_TYPE[item.contentType]) {
        throw new BadRequestException('Invalid content type');
      }
    }

    // `dto.assignments` is identical for every item, so validate the scope /
    // groupValue / recipientId shape and authorize recipient ownership ONCE,
    // before any delete. Otherwise a malformed or cross-tenant request would
    // wipe an item's existing assignments and then abort with no rollback,
    // leaving it silently unassigned.
    const effective = this.validateAssignments(dto.assignments);
    await this.assertRecipientsOwned(
      userId,
      effective
        .filter((a) => a.scope === 'individual' && a.recipientId)
        .map((a) => a.recipientId as string),
    );

    for (const item of dto.items) {
      const assignmentType = ASSIGNMENT_TYPE[item.contentType];

      // Verify the caller owns this content before (re)assigning recipients.
      // Without this an attacker could attach delivery rules to another
      // user's content id.
      await this.assertContentOwned(userId, item.contentType, item.contentId);

      await this.supabase
        .getClient()
        .from('content_assignments')
        .delete()
        .eq('user_id', userId)
        .eq('content_type', assignmentType)
        .eq('content_id', item.contentId);

      await this.insertAssignments(
        userId,
        assignmentType,
        item.contentId,
        effective,
      );
    }

    return { updated: dto.items.length };
  }

  async bulkDelete(userId: string, dto: BulkDeleteDto) {
    let deleted = 0;
    const skipped: { contentType: string; contentId: string }[] = [];

    for (const item of dto.items) {
      switch (item.contentType) {
        case 'message':
          await this.messagesService.deleteMessage(userId, item.contentId);
          deleted++;
          break;
        case 'document':
          await this.documentsService.deleteDocument(userId, item.contentId);
          deleted++;
          break;
        case 'photo':
          await this.photosService.deletePhoto(userId, item.contentId);
          deleted++;
          break;
        case 'chapter':
          await this.chaptersService.deleteChapter(userId, item.contentId);
          deleted++;
          break;
        default:
          skipped.push(item);
      }
    }

    return { deleted, skipped };
  }

  // Validates the scope/groupValue/recipientId shape and returns the effective
  // assignment list (defaulting to a single 'assign_later' row when empty).
  // Pure — no DB writes — so callers can run it before any destructive delete.
  private validateAssignments(assignments: AssignmentDto[]): AssignmentDto[] {
    const effective =
      assignments.length > 0 ? assignments : [{ scope: 'assign_later' }];

    for (const a of effective) {
      // The DB enforces group => group_value present, individual => recipient
      // present. Catch these here for a clean 400 instead of a DB-level 500.
      if (a.scope === 'group' && !a.groupValue) {
        throw new BadRequestException(
          'groupValue is required when scope is "group"',
        );
      }
      if (a.scope === 'individual' && !a.recipientId) {
        throw new BadRequestException(
          'recipientId is required when scope is "individual"',
        );
      }
    }

    return effective;
  }

  private async insertAssignments(
    userId: string,
    contentType: string,
    contentId: string,
    effective: AssignmentDto[],
  ) {
    // Single batched insert instead of one round trip per assignment.
    const rows = effective.map((a) => ({
      user_id: userId,
      content_type: contentType,
      content_id: contentId,
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
  }

  private async assertContentOwned(
    userId: string,
    contentType: string,
    contentId: string,
  ) {
    const table = CONTENT_TABLE[contentType];
    if (!table) throw new BadRequestException('Invalid content type');
    const { data, error } = await this.supabase
      .getClient()
      .from(table)
      .select('id')
      .eq('id', contentId)
      .eq('user_id', userId)
      .maybeSingle();
    // A real query failure must surface as 500, not be masked as "not owned".
    if (error) {
      throw new InternalServerErrorException('Failed to verify content ownership');
    }
    if (!data) {
      throw new ForbiddenException(
        'Content not found or not owned by this account',
      );
    }
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
}
