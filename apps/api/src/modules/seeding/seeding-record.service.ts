import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import mongoose from 'mongoose';
import {
  SeedingRecord,
  SeedingRecordDocument,
  ValidationError,
} from './schemas/seeding-record.schema';
import { SeedingRecordStatus, SeedingDefaults } from '../../common/constants';
import { Exceptions } from '../../common/errors';
import { validateObjectId, toObjectId } from '../../common/utils';

@Injectable()
export class SeedingRecordService {
  constructor(
    @InjectModel(SeedingRecord.name)
    private readonly recordModel: Model<SeedingRecordDocument>,
  ) {}

  async bulkCreate(
    sessionId: string,
    module: string,
    records: any[],
  ): Promise<SeedingRecordDocument[]> {
    validateObjectId(sessionId, 'sessionId');
    const docs = records.map((record) => ({
      sessionId: new mongoose.Types.ObjectId(sessionId),
      module,
      status: SeedingRecordStatus.RAW,
      rawData: record,
    }));
    return this.recordModel.insertMany(docs);
  }

  async create(input: {
    sessionId: string;
    module: string;
    rawData: any;
    transformedData?: any;
    status: string;
    cvbBusinessId?: string;
    validationErrors?: ValidationError[];
  }): Promise<SeedingRecordDocument> {
    validateObjectId(input.sessionId, 'sessionId');
    const doc = new this.recordModel({
      sessionId: new mongoose.Types.ObjectId(input.sessionId),
      module: input.module,
      status: input.status,
      rawData: input.rawData,
      transformedData: input.transformedData,
      cvbBusinessId: input.cvbBusinessId,
      ...(input.validationErrors
        ? { validationErrors: input.validationErrors }
        : {}),
    });
    return doc.save();
  }

  async updateRecord(
    id: string,
    update: Record<string, any>,
  ): Promise<void> {
    await this.recordModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: update },
    );
  }

  async findBySession(
    sessionId: string,
    filters: { module?: string; status?: string } = {},
  ): Promise<SeedingRecordDocument[]> {
    const query: Record<string, any> = {
      sessionId: toObjectId(sessionId, 'sessionId'),
    };
    if (filters.module) query.module = filters.module;
    if (filters.status) query.status = filters.status;
    return this.recordModel.find(query).exec();
  }

  async findOneByPublishedId(
    publishedId: string,
  ): Promise<SeedingRecordDocument | null> {
    return this.recordModel
      .findOne({ publishedId })
      .lean() as any;
  }

  async findOneByCvbBusinessId(
    cvbBusinessId: string,
  ): Promise<SeedingRecordDocument | null> {
    return this.recordModel
      .findOne({ cvbBusinessId })
      .lean() as any;
  }

  async findById(id: string): Promise<SeedingRecordDocument> {
    validateObjectId(id, 'recordId');
    const record = await this.recordModel.findById(id).exec();
    if (!record) throw Exceptions.recordNotFound(id);
    return record;
  }

  async updateStatus(
    id: string,
    status: string,
  ): Promise<SeedingRecordDocument> {
    const record = await this.recordModel
      .findByIdAndUpdate(id, { status }, { returnDocument: 'after' })
      .exec();
    if (!record) throw Exceptions.recordNotFound(id);
    return record;
  }

  async setValidationErrors(
    id: string,
    errors: ValidationError[],
  ): Promise<SeedingRecordDocument> {
    const record = await this.recordModel
      .findByIdAndUpdate(
        id,
        { validationErrors: errors },
        { returnDocument: 'after' },
      )
      .exec();
    if (!record) throw Exceptions.recordNotFound(id);
    return record;
  }

  async pushValidationIssue(
    id: string,
    issue: { field: string; message: string; severity: string },
  ): Promise<void> {
    validateObjectId(id, 'recordId');
    await this.recordModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $push: { validationErrors: issue } },
    );
  }

  async setFailureReason(
    id: string,
    reason: string,
    field: string = 'placeId',
  ): Promise<SeedingRecordDocument> {
    const record = await this.recordModel
      .findByIdAndUpdate(
        id,
        {
          $set: { errorMessage: reason },
          $push: {
            validationErrors: {
              field,
              message: reason,
              severity: 'error',
            },
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!record) throw Exceptions.recordNotFound(id);
    return record;
  }

  async setTransformedData(
    id: string,
    transformedData: any,
  ): Promise<SeedingRecordDocument> {
    const record = await this.recordModel
      .findByIdAndUpdate(
        id,
        { transformedData },
        { returnDocument: 'after' },
      )
      .exec();
    if (!record) throw Exceptions.recordNotFound(id);
    return record;
  }

  async setEnrichmentData(
    id: string,
    enrichmentData: any,
    source: string,
  ): Promise<SeedingRecordDocument> {
    const record = await this.recordModel
      .findByIdAndUpdate(
        id,
        { enrichmentData, enrichmentSource: source },
        { returnDocument: 'after' },
      )
      .exec();
    if (!record) throw Exceptions.recordNotFound(id);
    return record;
  }

  async markPublished(
    id: string,
    publishedId: string,
  ): Promise<SeedingRecordDocument> {
    const record = await this.recordModel
      .findByIdAndUpdate(
        id,
        {
          publishedId,
          publishedAt: new Date(),
          status: SeedingRecordStatus.PUBLISHED,
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!record) throw Exceptions.recordNotFound(id);
    return record;
  }

  async getStatusSummary(
    sessionId: string,
  ): Promise<Record<string, number>> {
    const results = await this.recordModel
      .aggregate([
        { $match: { sessionId: toObjectId(sessionId, 'sessionId') } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .exec();

    const summary: Record<string, number> = {};
    for (const r of results) {
      summary[r._id] = r.count;
    }
    return summary;
  }

  async findBySessionWithFullData(
    sessionId: string,
    filters: { module?: string; status?: string },
  ): Promise<SeedingRecordDocument[]> {
    validateObjectId(sessionId, 'sessionId');
    const query: Record<string, any> = {
      sessionId: toObjectId(sessionId, 'sessionId'),
    };
    if (filters.module) query.module = filters.module;
    if (filters.status) query.status = filters.status;
    return this.recordModel
      .find(query)
      .sort(SeedingDefaults.SORT_ORDER)
      .exec();
  }

  async findByIdWithFullData(id: string): Promise<SeedingRecordDocument> {
    validateObjectId(id, 'recordId');
    const record = await this.recordModel.findById(id).exec();
    if (!record) throw Exceptions.recordNotFound(id);
    return record;
  }

  async resetToTransformed(recordIds: string[]): Promise<void> {
    if (!recordIds || recordIds.length === 0) {
      throw Exceptions.missingRequiredField('recordIds');
    }
    const objectIds = recordIds.map((id) => {
      validateObjectId(id, 'recordId');
      return new mongoose.Types.ObjectId(id);
    });
    await this.recordModel
      .updateMany(
        { _id: { $in: objectIds } },
        {
          $set: { status: SeedingRecordStatus.TRANSFORMED },
          $unset: { enrichmentData: '', enrichmentSource: '' },
        },
      )
      .exec();
  }

  async findByIds(ids: string[]): Promise<SeedingRecordDocument[]> {
    const objectIds = ids.map((id) => {
      validateObjectId(id, 'recordId');
      return new mongoose.Types.ObjectId(id);
    });
    return this.recordModel.find({ _id: { $in: objectIds } }).exec();
  }

  async resetAllRecords(sessionId: string): Promise<void> {
    await this.recordModel
      .updateMany(
        { sessionId: toObjectId(sessionId, 'sessionId') },
        {
          $set: { status: SeedingRecordStatus.RAW, retryCount: 0 },
          $unset: {
            transformedData: '',
            enrichmentData: '',
            validationErrors: '',
            publishedId: '',
            publishedAt: '',
            errorMessage: '',
            botScrape: '',
          },
        },
      )
      .exec();
  }

  async deleteAllRecords(sessionId: string): Promise<void> {
    await this.recordModel
      .deleteMany({ sessionId: toObjectId(sessionId, 'sessionId') })
      .exec();
  }

  async bulkUpdateStatus(
    sessionId: string,
    fromStatus: string,
    toStatus: string,
  ): Promise<void> {
    await this.recordModel
      .updateMany(
        { sessionId: toObjectId(sessionId, 'sessionId'), status: fromStatus },
        { status: toStatus },
      )
      .exec();
  }

  private isPlainObject(value: any): boolean {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    );
  }

  private setDotPath(
    target: Record<string, any>,
    path: string,
    value: any,
  ): void {
    const parts = path.split('.');
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!this.isPlainObject(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  private async readBotScrape(
    publishedId: string,
  ): Promise<Record<string, any>> {
    const doc = await this.recordModel
      .findOne({ publishedId })
      .select('botScrape')
      .lean();
    const current = (doc as any)?.botScrape;
    return this.isPlainObject(current)
      ? { ...(current as Record<string, any>) }
      : {};
  }

  async setBotScrapeStatus(
    publishedId: string,
    update: {
      status: string;
      startedAt?: Date;
      completedAt?: Date;
      reviewCount?: number;
      galleryFolders?: number;
      galleryImages?: number;
      menuItems?: number;
      error?: string;
    },
  ): Promise<void> {
    const merged = await this.readBotScrape(publishedId);
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    await this.recordModel.updateOne(
      { publishedId },
      { $set: { botScrape: merged } },
    );
  }

  async getBotScrapeStatuses(sessionId: string) {
    return this.recordModel
      .find({
        sessionId: toObjectId(sessionId, 'sessionId'),
        status: 'published',
      })
      .select('publishedId botScrape')
      .lean();
  }

  async updateBotProgress(
    publishedId: string,
    update: Record<string, any>,
  ): Promise<void> {
    const merged = await this.readBotScrape(publishedId);
    for (const [key, value] of Object.entries(update)) {
      this.setDotPath(merged, key, value);
    }
    await this.recordModel.updateOne(
      { publishedId },
      { $set: { botScrape: merged } },
    );
  }

  async resetBotData(
    publishedId: string,
    stages: ('gallery' | 'menu' | 'reviews')[],
  ): Promise<void> {
    const merged = await this.readBotScrape(publishedId);

    if (stages.includes('gallery')) {
      this.setDotPath(merged, 'progress.gallery', {
        status: 'pending',
        folders: 0,
        images: 0,
        foldersTotal: 0,
        currentFolder: null,
      });
      merged.galleryFolders = 0;
      merged.galleryImages = 0;
    }

    if (stages.includes('menu')) {
      this.setDotPath(merged, 'progress.menu', {
        status: 'pending',
        items: 0,
      });
      merged.menuItems = 0;
    }

    if (stages.includes('reviews')) {
      this.setDotPath(merged, 'progress.reviews', {
        status: 'pending',
        current: 0,
        total: 0,
        expanding: 0,
      });
      merged.reviewCount = 0;
    }

    if (stages.length === 3) {
      merged.status = 'pending';
      merged.currentStage = null;
      merged.currentDetail = null;
      merged.completedAt = null;
      merged.error = null;
    } else {
      merged.status = 'pending';
      merged.completedAt = null;
    }

    await this.recordModel.updateOne(
      { publishedId },
      { $set: { botScrape: merged } },
    );
  }
}
