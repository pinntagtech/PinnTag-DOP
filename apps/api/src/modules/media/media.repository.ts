import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, UpdateQuery } from 'mongoose';
import {
  File,
  FileDocument,
  Image,
  ImageDocument,
  Drive,
  DriveDocument,
} from './media.schema';

@Injectable()
export class MediaRepository {
  constructor(
    @InjectModel(File.name) private readonly fileModel: Model<FileDocument>,
    @InjectModel(Image.name)
    private readonly imageModel: Model<ImageDocument>,
    @InjectModel(Drive.name)
    private readonly driveModel: Model<DriveDocument>,
  ) {}

  // File operations
  async createFile(data: Partial<File>): Promise<FileDocument> {
    return this.fileModel.create(data);
  }

  async findFileById(id: string): Promise<FileDocument | null> {
    return this.fileModel.findById(id).exec();
  }

  async findFiles(
    filter: Record<string, any> = {},
  ): Promise<FileDocument[]> {
    return this.fileModel.find(filter).exec();
  }

  async updateFile(
    id: string,
    data: UpdateQuery<File>,
  ): Promise<FileDocument | null> {
    return this.fileModel
      .findByIdAndUpdate(id, data, { returnDocument: 'after' })
      .exec();
  }

  async deleteFile(id: string): Promise<FileDocument | null> {
    return this.fileModel
      .findByIdAndUpdate(id, { isDeleted: true }, { returnDocument: 'after' })
      .exec();
  }

  // Image operations
  async createImage(data: Partial<Image>): Promise<ImageDocument> {
    return this.imageModel.create(data);
  }

  async findImageById(id: string): Promise<ImageDocument | null> {
    return this.imageModel.findById(id).exec();
  }

  async findImages(
    filter: Record<string, any> = {},
  ): Promise<ImageDocument[]> {
    return this.imageModel.find(filter).exec();
  }

  async updateImage(
    id: string,
    data: UpdateQuery<Image>,
  ): Promise<ImageDocument | null> {
    return this.imageModel
      .findByIdAndUpdate(id, data, { returnDocument: 'after' })
      .exec();
  }

  async deleteImage(id: string): Promise<ImageDocument | null> {
    return this.imageModel.findByIdAndDelete(id).exec();
  }

  // Drive operations
  async createDrive(data: Partial<Drive>): Promise<DriveDocument> {
    return this.driveModel.create(data);
  }

  async findDriveById(id: string): Promise<DriveDocument | null> {
    return this.driveModel.findById(id).exec();
  }

  async findDrives(
    filter: Record<string, any> = {},
  ): Promise<DriveDocument[]> {
    return this.driveModel.find(filter).exec();
  }

  async updateDrive(
    id: string,
    data: UpdateQuery<Drive>,
  ): Promise<DriveDocument | null> {
    return this.driveModel
      .findByIdAndUpdate(id, data, { returnDocument: 'after' })
      .exec();
  }

  async deleteDrive(id: string): Promise<DriveDocument | null> {
    return this.driveModel.findByIdAndDelete(id).exec();
  }
}
