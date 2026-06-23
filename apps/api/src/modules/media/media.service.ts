import { Injectable } from '@nestjs/common';
import { MediaRepository } from './media.repository';
import {
  File,
  FileDocument,
  Image,
  ImageDocument,
  Drive,
  DriveDocument,
} from './media.schema';

@Injectable()
export class MediaService {
  constructor(private readonly mediaRepository: MediaRepository) {}

  // File operations
  async createFile(data: Partial<File>): Promise<FileDocument> {
    return this.mediaRepository.createFile(data);
  }

  async findFileById(id: string): Promise<FileDocument | null> {
    return this.mediaRepository.findFileById(id);
  }

  async findFiles(
    filter: Record<string, any> = {},
  ): Promise<FileDocument[]> {
    return this.mediaRepository.findFiles(filter);
  }

  async updateFile(
    id: string,
    data: Partial<File>,
  ): Promise<FileDocument | null> {
    return this.mediaRepository.updateFile(id, data);
  }

  async deleteFile(id: string): Promise<FileDocument | null> {
    return this.mediaRepository.deleteFile(id);
  }

  // Image operations
  async createImage(data: Partial<Image>): Promise<ImageDocument> {
    return this.mediaRepository.createImage(data);
  }

  async findImageById(id: string): Promise<ImageDocument | null> {
    return this.mediaRepository.findImageById(id);
  }

  async findImages(
    filter: Record<string, any> = {},
  ): Promise<ImageDocument[]> {
    return this.mediaRepository.findImages(filter);
  }

  async updateImage(
    id: string,
    data: Partial<Image>,
  ): Promise<ImageDocument | null> {
    return this.mediaRepository.updateImage(id, data);
  }

  async deleteImage(id: string): Promise<ImageDocument | null> {
    return this.mediaRepository.deleteImage(id);
  }

  // Drive operations
  async createDrive(data: Partial<Drive>): Promise<DriveDocument> {
    return this.mediaRepository.createDrive(data);
  }

  async findDriveById(id: string): Promise<DriveDocument | null> {
    return this.mediaRepository.findDriveById(id);
  }

  async findDrives(
    filter: Record<string, any> = {},
  ): Promise<DriveDocument[]> {
    return this.mediaRepository.findDrives(filter);
  }

  async updateDrive(
    id: string,
    data: Partial<Drive>,
  ): Promise<DriveDocument | null> {
    return this.mediaRepository.updateDrive(id, data);
  }

  async deleteDrive(id: string): Promise<DriveDocument | null> {
    return this.mediaRepository.deleteDrive(id);
  }
}
