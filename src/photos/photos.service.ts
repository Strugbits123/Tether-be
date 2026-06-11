import { randomUUID } from 'crypto';
import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../shared/supabase/supabase.service.js';
import { FileDescriptorDto } from './dto/request-upload-urls.dto.js';
import { AssignmentDto, CreatePhotosBatchDto } from './dto/create-photos-batch.dto.js';
import { ActivityService } from '../activity/activity.service.js';

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
          // TODO Sprint 3: run Sharp compression and store compressed path
          storage_path_compressed: photo.storagePath,
          file_type: photo.fileType,
          file_size_bytes: photo.fileSizeBytes,
          title: null,
          caption: dto.caption ?? null,
          width: photo.width ?? null,
          height: photo.height ?? null,
          display_order: 0,
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
              assignment.scope === 'group' ? (assignment.groupValue ?? null) : null,
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

  async listPhotos(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('photos')
      .select('*')
      .eq('user_id', userId)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch photos');
    }

    const photos = await Promise.all(
      (data ?? []).map(async (photo) => {
        const { data: urlData } = await this.supabase
          .getClient()
          .storage.from('photos')
          .createSignedUrl(photo.storage_path, 3600);

        return { ...photo, signedUrl: urlData?.signedUrl ?? null };
      }),
    );

    return photos;
  }

  async deletePhoto(userId: string, photoId: string) {
    const { data: photo, error: fetchError } = await this.supabase
      .getClient()
      .from('photos')
      .select('*')
      .eq('id', photoId)
      .single();

    if (fetchError || !photo) {
      throw new NotFoundException('Photo not found');
    }

    if (photo.user_id !== userId) {
      throw new ForbiddenException('Not your photo');
    }

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

    return { success: true };
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
