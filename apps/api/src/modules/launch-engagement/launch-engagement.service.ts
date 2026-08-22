import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import { EnvironmentUriKey } from '../../common/constants';

const LOOSE_SCHEMA = new mongoose.Schema<any>(
  {},
  { strict: false, timestamps: true },
);

export interface StatusResult {
  targetEnvironment: string;
  businessId: string;
  isLaunchEngagementBeta: boolean;
  engagementCountsByType: Record<string, number>;
}

@Injectable()
export class LaunchEngagementService {
  private readonly logger = new Logger(LaunchEngagementService.name);

  constructor(private readonly configService: ConfigService) {}

  async enroll(targetEnvironment: string, businessId: string) {
    return this.setFlag(targetEnvironment, businessId, true);
  }

  async unenroll(targetEnvironment: string, businessId: string) {
    return this.setFlag(targetEnvironment, businessId, false);
  }

  async status(
    targetEnvironment: string,
    businessId: string,
  ): Promise<StatusResult> {
    const conn = await this.openTargetConn(targetEnvironment);
    try {
      const BusinessModel = conn.model('Business', LOOSE_SCHEMA, 'businesses');
      const EngagementEventModel = conn.model(
        'EngagementEvent',
        LOOSE_SCHEMA,
        'engagementevents',
      );

      const oid = new mongoose.Types.ObjectId(businessId);
      const business = (await BusinessModel.findById(oid)
        .select('_id isLaunchEngagementBeta')
        .lean()) as any;

      if (!business) {
        throw new HttpException(
          `Business ${businessId} not found in ${targetEnvironment}`,
          404,
        );
      }

      const grouped = await EngagementEventModel.aggregate([
        { $match: { businessProfile: oid } },
        { $group: { _id: '$type', n: { $sum: 1 } } },
      ]);

      const engagementCountsByType: Record<string, number> = {};
      for (const row of grouped as Array<{ _id: string; n: number }>) {
        engagementCountsByType[row._id ?? 'unknown'] = row.n;
      }

      return {
        targetEnvironment,
        businessId,
        isLaunchEngagementBeta: !!business.isLaunchEngagementBeta,
        engagementCountsByType,
      };
    } finally {
      await conn.close();
    }
  }

  private async setFlag(
    targetEnvironment: string,
    businessId: string,
    value: boolean,
  ) {
    const conn = await this.openTargetConn(targetEnvironment);
    try {
      const BusinessModel = conn.model('Business', LOOSE_SCHEMA, 'businesses');
      const oid = new mongoose.Types.ObjectId(businessId);

      const updated = (await BusinessModel.findOneAndUpdate(
        { _id: oid },
        { $set: { isLaunchEngagementBeta: value } },
        { new: true, projection: { _id: 1, name: 1, isLaunchEngagementBeta: 1 } },
      ).lean()) as any;

      if (!updated) {
        throw new HttpException(
          `Business ${businessId} not found in ${targetEnvironment}`,
          404,
        );
      }

      this.logger.log(
        `[LAUNCH-ENGAGEMENT] ${value ? 'ENROLL' : 'UNENROLL'} ` +
          `env=${targetEnvironment} businessId=${businessId} ` +
          `name="${updated.name ?? ''}"`,
      );

      return {
        targetEnvironment,
        businessId,
        name: updated.name ?? null,
        isLaunchEngagementBeta: !!updated.isLaunchEngagementBeta,
      };
    } finally {
      await conn.close();
    }
  }

  private async openTargetConn(
    targetEnvironment: string,
  ): Promise<mongoose.Connection> {
    const uriKey =
      EnvironmentUriKey[targetEnvironment as keyof typeof EnvironmentUriKey];
    const uri = uriKey ? this.configService.get<string>(uriKey) : undefined;
    if (!uri) {
      throw new HttpException(
        `No database URI configured for environment: ${targetEnvironment}`,
        400,
      );
    }
    return mongoose.createConnection(uri).asPromise();
  }
}
