import { randomUUID } from 'crypto';
import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { PostHogService } from '../shared/posthog/posthog.service.js';
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
    const effectiveAssignments: AssignmentDto[] =
      dto.assignments.length > 0
        ? dto.assignments
        : [{ scope: 'assign_later' }];

    const createdPhotos: Record<string, unknown>[] = [];

    for (const photo of dto.photos) {
      const { data: createdPhoto, error: photoError } = await this.supabase
        .getClient()
        .from('photos')
        .insert({
          user_id: userId,
          storage_path: photo.storagePath,
          storage_path_compressed: photo.storagePath,
          file_type: photo.fileType,
          file_size_bytes: photo.fileSizeBytes,
          title: photo.title ?? null,
          caption: dto.caption ?? null,
          width: photo.width ?? null,
          height: photo.height ?? null,
          display_order: 0,
          folder_id: dto.folderId ?? null,
        })
        .select()
        .single();

      if (photoError || !createdPhoto) {
        throw new InternalServerErrorException('Failed to save photo record');
      }

      for (const assignment of effectiveAssignments) {
        const { error: assignError } = await this.supabase
          .getClient()
          .from('content_assignments')
          .insert({
            user_id: userId,
            content_type: 'photo',
            content_id: createdPhoto.id,
            assignment_scope: assignment.scope,
            group_value:
              assignment.scope === 'group'
                ? (assignment.groupValue ?? null)
                : null,
            recipient_id:
              assignment.scope === 'individual'
                ? (assignment.recipientId ?? null)
                : null,
          });

        if (assignError) {
          throw new InternalServerErrorException(
            'Failed to save content assignment',
          );
        }
      }

      createdPhotos.push(createdPhoto);
    }

    this.markOnboardingAddPhotos(userId).catch(() => null);
    this.posthog.capture(userId, 'server_photos_uploaded', {
      count: createdPhotos.length,
      folder_id: dto.folderId ?? 'uncategorized',
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

    const { data: urlResults } = await this.supabase
      .getClient()
      .storage.from('photos')
      .createSignedUrls(
        rows.map((p) => p.storage_path),
        3600,
      );

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

    const { data: urlData } = await this.supabase
      .getClient()
      .storage.from('photos')
      .createSignedUrl(photo.storage_path, 3600);

    return { ...photo, signedUrl: urlData?.signedUrl ?? null };
  }

  async updatePhoto(userId: string, photoId: string, dto: UpdatePhotoDto) {
    await this.requireOwnedPhoto(userId, photoId);

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

    if (dto.assignments !== undefined) {
      await this.supabase
        .getClient()
        .from('content_assignments')
        .delete()
        .eq('content_type', 'photo')
        .eq('content_id', photoId);

      for (const assignment of dto.assignments) {
        const { error: assignError } = await this.supabase
          .getClient()
          .from('content_assignments')
          .insert({
            user_id: userId,
            content_type: 'photo',
            content_id: photoId,
            assignment_scope: assignment.scope,
            group_value:
              assignment.scope === 'group'
                ? (assignment.groupValue ?? null)
                : null,
            recipient_id:
              assignment.scope === 'individual'
                ? (assignment.recipientId ?? null)
                : null,
          });

        if (assignError) {
          throw new InternalServerErrorException('Failed to update assignment');
        }
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
    const { data: folder, error: folderError } = await this.supabase
      .getClient()
      .from('photo_folders')
      .insert({ user_id: userId, name: dto.name })
      .select()
      .single();

    if (folderError || !folder) {
      throw new InternalServerErrorException('Failed to create folder');
    }

    for (const assignment of dto.assignments) {
      const { error: assignError } = await this.supabase
        .getClient()
        .from('content_assignments')
        .insert({
          user_id: userId,
          content_type: 'photo_folder',
          content_id: folder.id,
          assignment_scope: assignment.scope,
          group_value:
            assignment.scope === 'group'
              ? (assignment.groupValue ?? null)
              : null,
          recipient_id:
            assignment.scope === 'individual'
              ? (assignment.recipientId ?? null)
              : null,
        });

      if (assignError) {
        throw new InternalServerErrorException(
          'Failed to save folder assignment',
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

    const foldersWithCounts = await Promise.all(
      (folders ?? []).map(async (folder) => {
        const { count } = await this.supabase
          .getClient()
          .from('photos')
          .select('*', { count: 'exact', head: true })
          .eq('folder_id', folder.id);

        return { ...folder, photoCount: count ?? 0 };
      }),
    );

    const { count: uncategorizedCount } = await this.supabase
      .getClient()
      .from('photos')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('folder_id', null);

    return {
      folders: foldersWithCounts,
      uncategorizedCount: uncategorizedCount ?? 0,
    };
  }

  async updateFolder(userId: string, folderId: string, dto: UpdateFolderDto) {
    await this.requireOwnedFolder(userId, folderId);

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

  private async markOnboardingAddPhotos(userId: string) {
    const { data } = await this.supabase
      .getClient()
      .from('users')
      .select('onboarding')
      .eq('id', userId)
      .single();

    if (!data) return;

    const onboarding = (data.onboarding ?? {}) as Record<string, unknown>;
    onboarding['add_photos'] = true;

    const steps = [
      'finish_account',
      'add_release_manager',
      'add_recipients',
      'add_photos',
      'create_message',
    ];
    if (steps.every((s) => onboarding[s] === true)) {
      onboarding['completed_at'] = new Date().toISOString();
    }

    await this.supabase
      .getClient()
      .from('users')
      .update({ onboarding, updated_at: new Date().toISOString() })
      .eq('id', userId);
  }
}
