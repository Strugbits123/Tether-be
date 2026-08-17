import { randomUUID } from 'crypto';
import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
import { AnalyticsService } from '../shared/posthog/analytics.service.js';
import { FileDescriptorDto } from './dto/request-upload-urls.dto.js';
import {
  AssignmentDto,
  CreatePhotosBatchDto,
} from './dto/create-photos-batch.dto.js';
import { ActivityService } from '../activity/activity.service.js';
import { CreateFolderDto } from './dto/create-folder.dto.js';
import { UpdateFolderDto } from './dto/update-folder.dto.js';
import { UpdatePhotoDto } from './dto/update-photo.dto.js';
import { MovePhotoDto } from './dto/move-photo.dto.js';

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/webp': 'webp',
};

@Injectable()
export class PhotosService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly activityService: ActivityService,
    private readonly posthog: PostHogService,
    private readonly analytics: AnalyticsService,
  ) {}

  async getUploadUrls(userId: string, files: FileDescriptorDto[]) {
    const results: {
      signedUploadUrl: string;
      token: string;
      storagePath: string;
      fileIndex: number;
    }[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = MIME_TO_EXT[file.fileType] ?? 'jpg';
      const storagePath = `${userId}/${randomUUID()}.${ext}`;

      const { data, error } = await this.supabase
        .getClient()
        .storage.from('photos')
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

  async createBatch(userId: string, dto: CreatePhotosBatchDto) {
    // Reject a folder that doesn't belong to this user (cross-tenant guard).
    if (dto.folderId) {
      await this.requireOwnedFolder(userId, dto.folderId);
    }

    const effectiveAssignments: AssignmentDto[] =
      dto.assignments.length > 0
        ? dto.assignments
        : [{ scope: 'assign_later' }];

    await this.assertRecipientsOwned(
      userId,
      effectiveAssignments
        .filter((a) => a.scope === 'individual' && a.recipientId)
        .map((a) => a.recipientId as string),
    );

    const photosPayload = dto.photos.map((photo) => ({
      storage_path: photo.storagePath,
      file_type: photo.fileType,
      file_size_bytes: photo.fileSizeBytes,
      title: photo.title ?? null,
      width: photo.width ?? null,
      height: photo.height ?? null,
    }));
    const assignmentRows = effectiveAssignments.map((assignment) => ({
      assignment_scope: assignment.scope,
      group_value:
        assignment.scope === 'group' ? (assignment.groupValue ?? null) : null,
      recipient_id:
        assignment.scope === 'individual'
          ? (assignment.recipientId ?? null)
          : null,
    }));

    // Insert every photo + its assignments in one transaction so a failed
    // assignment insert can't leave orphaned photo rows, and a mid-batch
    // failure can't leave a partially-committed (retry-duplicating) batch.
    const { data, error } = await this.supabase
      .getClient()
      .rpc('create_photos_with_assignments', {
        p_user_id: userId,
        p_photos: photosPayload,
        p_assignments: assignmentRows,
        p_caption: dto.caption ?? null,
        p_folder_id: dto.folderId ?? null,
      });

    if (error || !data) {
      throw new InternalServerErrorException('Failed to save photos');
    }

    const createdPhotos = data as Record<string, unknown>[];

    this.analytics.markOnboardingStep(userId, 'add_photos').catch(() => null);

    const totalBytes = dto.photos.reduce(
      (sum, p) => sum + (p.fileSizeBytes ?? 0),
      0,
    );
    const recipientCount = effectiveAssignments.filter(
      (a) => a.scope === 'individual' && a.recipientId,
    ).length;
    this.posthog.capture(userId, 'photo_uploaded', {
      count: createdPhotos.length,
      folder: dto.folderId ?? 'uncategorized',
      file_size_kb: Math.round(totalBytes / 1024),
      recipient_count: recipientCount,
    });

    this.activityService.log(
      userId,
      'photos_uploaded',
      `${createdPhotos.length} photo${createdPhotos.length > 1 ? 's' : ''} uploaded`,
      {
        count: createdPhotos.length,
        photoIds: createdPhotos.map((p) => (p as Record<string, unknown>).id),
      },
    );

    return { count: createdPhotos.length, photos: createdPhotos };
  }

  async listPhotos(userId: string, folderId?: string) {
    let query = this.supabase
      .getClient()
      .from('photos')
      .select('*')
      .eq('user_id', userId)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (folderId === 'uncategorized' || folderId === 'null') {
      query = query.is('folder_id', null);
    } else if (folderId) {
      query = query.eq('folder_id', folderId);
    }

    const { data, error } = await query;

    if (error) {
      throw new InternalServerErrorException('Failed to fetch photos');
    }

    const rows = data ?? [];
    if (rows.length === 0) return [];

    const { data: urlResults, error: urlError } = await this.supabase
      .getClient()
      .storage.from('photos')
      .createSignedUrls(
        rows.map((p) => p.storage_path),
        3600,
      );

    if (urlError) {
      throw new InternalServerErrorException('Failed to generate photo URLs');
    }

    const urlMap = new Map(
      (urlResults ?? []).map((r) => [r.path, r.signedUrl]),
    );

    return rows.map((photo) => ({
      ...photo,
      signedUrl: urlMap.get(photo.storage_path) ?? null,
    }));
  }

  async getPhoto(userId: string, photoId: string) {
    const photo = await this.requireOwnedPhoto(userId, photoId);

    const { data: urlData, error: urlError } = await this.supabase
      .getClient()
      .storage.from('photos')
      .createSignedUrl(photo.storage_path, 3600);

    if (urlError || !urlData) {
      throw new InternalServerErrorException('Failed to generate photo URL');
    }

    const { data: assignments, error: assignmentsError } = await this.supabase
      .getClient()
      .from('content_assignments')
      .select('assignment_scope, group_value, recipient_id')
      .eq('content_type', 'photo')
      .eq('content_id', photoId);

    if (assignmentsError) {
      throw new InternalServerErrorException('Failed to fetch assignments');
    }

    return {
      ...photo,
      signedUrl: urlData.signedUrl,
      assignments: assignments ?? [],
    };
  }

  async updatePhoto(userId: string, photoId: string, dto: UpdatePhotoDto) {
    await this.requireOwnedPhoto(userId, photoId);

    // Authorize recipients BEFORE mutating the photo, so a cross-tenant
    // recipient can't change the title/caption and then fail with 403.
    let assignmentRows:
      | { assignment_scope: string; group_value: string | null; recipient_id: string | null }[]
      | null = null;
    if (dto.assignments !== undefined) {
      await this.assertRecipientsOwned(
        userId,
        dto.assignments
          .filter((a) => a.scope === 'individual' && a.recipientId)
          .map((a) => a.recipientId as string),
      );
      assignmentRows = dto.assignments.map((assignment) => ({
        assignment_scope: assignment.scope,
        group_value:
          assignment.scope === 'group' ? (assignment.groupValue ?? null) : null,
        recipient_id:
          assignment.scope === 'individual'
            ? (assignment.recipientId ?? null)
            : null,
      }));
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (dto.title !== undefined) updates.title = dto.title;
    if (dto.caption !== undefined) updates.caption = dto.caption;

    const { data: updated, error: updateError } = await this.supabase
      .getClient()
      .from('photos')
      .update(updates)
      .eq('id', photoId)
      .select()
      .single();

    if (updateError || !updated) {
      throw new InternalServerErrorException('Failed to update photo');
    }

    if (assignmentRows !== null) {
      // Transactional replace: delete + insert in one RPC so a failed insert
      // can't permanently leave the photo unassigned.
      const { error: replaceError } = await this.supabase
        .getClient()
        .rpc('replace_content_assignments', {
          p_user_id: userId,
          p_content_type: 'photo',
          p_content_id: photoId,
          p_rows: assignmentRows,
        });
      if (replaceError) {
        throw new InternalServerErrorException('Failed to update assignment');
      }
    }

    return updated;
  }

  async movePhoto(userId: string, photoId: string, dto: MovePhotoDto) {
    await this.requireOwnedPhoto(userId, photoId);

    if (dto.folderId) {
      const { data: folder, error: folderError } = await this.supabase
        .getClient()
        .from('photo_folders')
        .select('id')
        .eq('id', dto.folderId)
        .eq('user_id', userId)
        .single();

      if (folderError || !folder) {
        throw new NotFoundException('Folder not found');
      }
    }

    const { data: updated, error: updateError } = await this.supabase
      .getClient()
      .from('photos')
      .update({
        folder_id: dto.folderId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', photoId)
      .select()
      .single();

    if (updateError || !updated) {
      throw new InternalServerErrorException('Failed to move photo');
    }

    return updated;
  }

  async getDownloadUrl(userId: string, photoId: string) {
    const photo = await this.requireOwnedPhoto(userId, photoId);

    const { data: urlData, error: urlError } = await this.supabase
      .getClient()
      .storage.from('photos')
      .createSignedUrl(photo.storage_path, 900, {
        download: photo.title || 'photo',
      });

    if (urlError || !urlData) {
      throw new InternalServerErrorException('Failed to generate download URL');
    }

    return { downloadUrl: urlData.signedUrl, expiresIn: 900 };
  }

  async deletePhoto(userId: string, photoId: string) {
    const photo = await this.requireOwnedPhoto(userId, photoId);

    await this.supabase
      .getClient()
      .storage.from('photos')
      .remove([photo.storage_path]);

    if (
      photo.storage_path_compressed &&
      photo.storage_path_compressed !== photo.storage_path
    ) {
      await this.supabase
        .getClient()
        .storage.from('photos')
        .remove([photo.storage_path_compressed]);
    }

    const { error: deleteError } = await this.supabase
      .getClient()
      .from('photos')
      .delete()
      .eq('id', photoId);

    if (deleteError) {
      throw new InternalServerErrorException('Failed to delete photo');
    }

    return { message: 'Photo deleted' };
  }

  // Folder methods

  async createFolder(userId: string, dto: CreateFolderDto) {
    // Validate recipients BEFORE creating anything — this both closes the
    // cross-tenant IDOR (createFolder previously never checked) and prevents
    // leaving an orphaned folder behind when an assignment would be rejected.
    await this.assertRecipientsOwned(
      userId,
      dto.assignments
        .filter((a) => a.scope === 'individual' && a.recipientId)
        .map((a) => a.recipientId as string),
    );

    const { data: folder, error: folderError } = await this.supabase
      .getClient()
      .from('photo_folders')
      .insert({ user_id: userId, name: dto.name })
      .select()
      .single();

    if (folderError || !folder) {
      throw new InternalServerErrorException('Failed to create folder');
    }

    if (dto.assignments.length > 0) {
      const rows = dto.assignments.map((assignment) => ({
        user_id: userId,
        content_type: 'photo_folder',
        content_id: folder.id,
        assignment_scope: assignment.scope,
        group_value:
          assignment.scope === 'group' ? (assignment.groupValue ?? null) : null,
        recipient_id:
          assignment.scope === 'individual'
            ? (assignment.recipientId ?? null)
            : null,
      }));

      const { error: assignError } = await this.supabase
        .getClient()
        .from('content_assignments')
        .insert(rows);

      if (assignError) {
        // Compensating delete so a failed assignment insert doesn't leave an
        // orphaned, assignment-less folder behind.
        await this.supabase
          .getClient()
          .from('photo_folders')
          .delete()
          .eq('id', folder.id);
        throw new InternalServerErrorException(
          'Failed to save folder assignments',
        );
      }
    }

    this.activityService.log(
      userId,
      'photo_folder_created',
      `Folder "${dto.name}" created`,
      { folderId: folder.id },
    );

    return folder;
  }

  async listFolders(userId: string) {
    const { data: folders, error } = await this.supabase
      .getClient()
      .from('photo_folders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch folders');
    }

    const folderIds = (folders ?? []).map((f) => f.id);
    let photoRows: { folder_id: string }[] = [];
    if (folderIds.length) {
      const { data, error: photoCountError } = await this.supabase
        .getClient()
        .from('photos')
        .select('folder_id')
        .in('folder_id', folderIds);
      if (photoCountError) {
        throw new InternalServerErrorException('Failed to fetch folder counts');
      }
      photoRows = (data ?? []) as { folder_id: string }[];
    }
    const countMap = photoRows.reduce<Record<string, number>>(
      (acc, row) => {
        acc[row.folder_id] = (acc[row.folder_id] ?? 0) + 1;
        return acc;
      },
      {},
    );

    // Batch-fetch every folder's recipient assignments in one query so the edit
    // modal can pre-fill the current selection.
    let assignmentRows: {
      content_id: string;
      assignment_scope: string;
      group_value: string | null;
      recipient_id: string | null;
    }[] = [];
    if (folderIds.length) {
      const { data, error: folderAssignError } = await this.supabase
        .getClient()
        .from('content_assignments')
        .select('content_id, assignment_scope, group_value, recipient_id')
        .eq('user_id', userId)
        .eq('content_type', 'photo_folder')
        .in('content_id', folderIds);
      if (folderAssignError) {
        throw new InternalServerErrorException(
          'Failed to fetch folder assignments',
        );
      }
      assignmentRows = (data ?? []) as typeof assignmentRows;
    }
    const assignmentsMap = assignmentRows.reduce<
      Record<
        string,
        {
          assignment_scope: string;
          group_value: string | null;
          recipient_id: string | null;
        }[]
      >
    >((acc, row) => {
      (acc[row.content_id] ??= []).push({
        assignment_scope: row.assignment_scope,
        group_value: row.group_value,
        recipient_id: row.recipient_id,
      });
      return acc;
    }, {});

    const foldersWithCounts = (folders ?? []).map((folder) => ({
      ...folder,
      photoCount: countMap[folder.id] ?? 0,
      assignments: assignmentsMap[folder.id] ?? [],
    }));

    const { count: uncategorizedCount, error: uncategorizedError } =
      await this.supabase
        .getClient()
        .from('photos')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('folder_id', null);

    if (uncategorizedError) {
      throw new InternalServerErrorException('Failed to fetch folder counts');
    }

    return {
      folders: foldersWithCounts,
      uncategorizedCount: uncategorizedCount ?? 0,
    };
  }

  async updateFolder(userId: string, folderId: string, dto: UpdateFolderDto) {
    await this.requireOwnedFolder(userId, folderId);

    // Authorize recipients BEFORE mutating the folder, so a cross-tenant
    // recipient can't rename the folder and then fail with 403.
    let assignmentRows:
      | { assignment_scope: string; group_value: string | null; recipient_id: string | null }[]
      | null = null;
    if (dto.assignments) {
      await this.assertRecipientsOwned(
        userId,
        dto.assignments
          .filter((a) => a.scope === 'individual' && a.recipientId)
          .map((a) => a.recipientId as string),
      );
      assignmentRows = dto.assignments.map((assignment) => ({
        assignment_scope: assignment.scope,
        group_value:
          assignment.scope === 'group' ? (assignment.groupValue ?? null) : null,
        recipient_id:
          assignment.scope === 'individual'
            ? (assignment.recipientId ?? null)
            : null,
      }));
    }

    const { data: updated, error: updateError } = await this.supabase
      .getClient()
      .from('photo_folders')
      .update({ name: dto.name, updated_at: new Date().toISOString() })
      .eq('id', folderId)
      .select()
      .single();

    if (updateError || !updated) {
      throw new InternalServerErrorException('Failed to rename folder');
    }

    // Transactional replace so a failed insert can't permanently leave the
    // folder unassigned.
    if (assignmentRows !== null) {
      const { error: replaceError } = await this.supabase
        .getClient()
        .rpc('replace_content_assignments', {
          p_user_id: userId,
          p_content_type: 'photo_folder',
          p_content_id: folderId,
          p_rows: assignmentRows,
        });
      if (replaceError) {
        throw new InternalServerErrorException(
          'Failed to update folder assignments',
        );
      }
    }

    return updated;
  }

  async deleteFolder(userId: string, folderId: string) {
    await this.requireOwnedFolder(userId, folderId);

    await this.supabase
      .getClient()
      .from('photos')
      .update({ folder_id: null })
      .eq('folder_id', folderId);

    const { error: deleteError } = await this.supabase
      .getClient()
      .from('photo_folders')
      .delete()
      .eq('id', folderId);

    if (deleteError) {
      throw new InternalServerErrorException('Failed to delete folder');
    }

    return { success: true };
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

  private async requireOwnedPhoto(userId: string, photoId: string) {
    const { data: photo, error } = await this.supabase
      .getClient()
      .from('photos')
      .select('*')
      .eq('id', photoId)
      .eq('user_id', userId)
      .single();
    if (error || !photo) throw new NotFoundException('Photo not found');
    return photo;
  }

  private async requireOwnedFolder(userId: string, folderId: string) {
    const { data: folder, error } = await this.supabase
      .getClient()
      .from('photo_folders')
      .select('id, user_id, name')
      .eq('id', folderId)
      .eq('user_id', userId)
      .single();
    if (error || !folder) throw new NotFoundException('Folder not found');
    return folder;
  }
}
