import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SeedingLog, SeedingLogDocument } from './schemas/seeding-log.schema';
import { SeedingDefaults } from '../../common/constants';

@Injectable()
export class SeedingLogService {
  constructor(
    @InjectModel(SeedingLog.name)
    private readonly logModel: Model<SeedingLogDocument>,
  ) {}

  async log(params: {
    sessionId: string;
    action: string;
    actor: string;
    recordId?: string;
    fromStatus?: string;
    toStatus?: string;
    message?: string;
    metadata?: any;
  }): Promise<SeedingLogDocument> {
    const doc = new this.logModel({
      sessionId: new Types.ObjectId(params.sessionId),
      action: params.action,
      actor: params.actor,
      recordId: params.recordId
        ? new Types.ObjectId(params.recordId)
        : undefined,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      message: params.message,
      metadata: params.metadata,
    });
    return doc.save();
  }

  async getSessionLogs(sessionId: string): Promise<SeedingLogDocument[]> {
    return this.logModel
      .find({ sessionId: new Types.ObjectId(sessionId) })
      .sort(SeedingDefaults.SORT_ORDER)
      .exec();
  }

  async deleteSessionLogs(sessionId: string): Promise<void> {
    await this.logModel
      .deleteMany({ sessionId: new Types.ObjectId(sessionId) })
      .exec();
  }

  async getRecordLogs(recordId: string): Promise<SeedingLogDocument[]> {
    return this.logModel
      .find({ recordId: new Types.ObjectId(recordId) })
      .sort(SeedingDefaults.SORT_ORDER)
      .exec();
  }
}
