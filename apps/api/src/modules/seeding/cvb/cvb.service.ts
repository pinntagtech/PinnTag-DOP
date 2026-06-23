import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import { SeedingRecordService } from '../seeding-record.service';
import { SeedingLogService } from '../seeding-log.service';
import { SeedingSessionService } from '../seeding-session.service';
import {
  SeedingLogActions,
  SeedingRecordStatus,
} from '../../../common/constants';
import { validateCvbBusiness } from './cvb-validator';

@Injectable()
export class CvbService {
  private readonly logger = new Logger(CvbService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly recordService: SeedingRecordService,
    private readonly logService: SeedingLogService,
    private readonly sessionService: SeedingSessionService,
  ) {}

  // Query CVB businesses from staging DB with filters
  async queryCvbBusinesses(filters: {
    city?: string;
    state?: string;
    industry?: string;
    category?: string;
    search?: string;
    hasPlaceId?: boolean;
    hasMissingFields?: boolean;
    alreadyImported?: boolean;
    sessionId?: string;
    sortBy?: 'newest' | 'oldest' | 'name';
    page?: number;
    limit?: number;
  }): Promise<{
    businesses: any[];
    total: number;
    page: number;
    pages: number;
  }> {
    const stagingUri = this.configService.get<string>(
      'database.pinntagStaging',
    );
    if (!stagingUri) {
      throw new Error('No URI configured for staging');
    }
    const conn = await mongoose
      .createConnection(stagingUri)
      .asPromise();

    try {
      const BusinessModel = conn.model(
        'Business',
        new mongoose.Schema({}, { strict: false }),
        'businesses',
      );

      const page = filters.page || 1;
      const limit = Math.min(filters.limit || 20, 100);
      const skip = (page - 1) * limit;

      // Build query — CVB pool now includes crawler-sourced
      // businesses (isFromCrawler), so the base filter is an $or.
      // Wrap it in $and so the per-filter $or blocks below
      // (search, hasPlaceId, hasMissingFields) don't clobber it.
      const query: Record<string, any> = {
        isDeleted: { $ne: true },
        $and: [
          { $or: [{ isCvb: true }, { isFromCrawler: true }] },
        ],
      };

      if (filters.city) {
        query.city = new RegExp(filters.city, 'i');
      }
      if (filters.state) {
        query.state = new RegExp(filters.state, 'i');
      }
      if (filters.industry) {
        query.businessIndustry = new mongoose.Types.ObjectId(
          filters.industry,
        );
      }
      if (filters.category) {
        query.businessCategories = {
          $in: [new mongoose.Types.ObjectId(filters.category)],
        };
      }
      if (filters.search) {
        query.$and.push({
          $or: [
            { name: new RegExp(filters.search, 'i') },
            { email: new RegExp(filters.search, 'i') },
            { phone: new RegExp(filters.search, 'i') },
          ],
        });
      }
      if (filters.hasPlaceId === true) {
        query.placeId = { $exists: true, $nin: [null, ''] };
      }
      if (filters.hasPlaceId === false) {
        query.$and.push({
          $or: [
            { placeId: { $exists: false } },
            { placeId: null },
            { placeId: '' },
          ],
        });
      }
      if (filters.hasMissingFields === true) {
        query.$and.push({
          $or: [
            { phone: { $in: [null, '', undefined] } },
            { email: { $in: [null, '', undefined] } },
            { website: { $in: [null, '', undefined] } },
            { placeId: { $in: [null, '', undefined] } },
          ],
        });
      }

      const sortOrder: Record<string, any> = {
        newest: { createdAt: -1 },
        oldest: { createdAt: 1 },
        name: { name: 1 },
      };
      const sort =
        sortOrder[filters.sortBy || 'newest'] ||
        { createdAt: -1 };

      const [businesses, total] = await Promise.all([
        BusinessModel
          .find(query)
          .select(
            '_id name city state country phone email ' +
            'website placeId rating userRatingCount ' +
            'businessIndustry businessCategories ' +
            'logo cover regularTiming tags ' +
            'isActive isClaimed createdAt updatedAt',
          )
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .lean(),
        BusinessModel.countDocuments(query),
      ]);

      // Enrich with industry and category names
      const industryIds = [...new Set(
        businesses
          .map((b: any) => b.businessIndustry?.toString())
          .filter(Boolean),
      )];
      const categoryIds = [...new Set(
        businesses
          .flatMap((b: any) =>
            (b.businessCategories || []).map((c: any) =>
              c.toString(),
            ),
          )
          .filter(Boolean),
      )];

      const db = conn.db!;
      const [industryDocs, categoryDocs] = await Promise.all([
        db
          .collection('businessindustries')
          .find({
            _id: {
              $in: industryIds.map(
                (id) => new mongoose.Types.ObjectId(id),
              ),
            },
          })
          .project({ _id: 1, name: 1, title: 1 })
          .toArray(),
        db
          .collection('businesscategories')
          .find({
            _id: {
              $in: categoryIds.map(
                (id) => new mongoose.Types.ObjectId(id),
              ),
            },
          })
          .project({ _id: 1, name: 1, title: 1 })
          .toArray(),
      ]);

      const industryMap = new Map(
        industryDocs.map((i: any) => [
          i._id.toString(),
          i.name || i.title || 'Unknown',
        ]),
      );
      const categoryMap = new Map(
        categoryDocs.map((c: any) => [
          c._id.toString(),
          c.name || c.title || 'Unknown',
        ]),
      );

      const enriched = businesses.map((b: any) => ({
        ...b,
        industryName: b.businessIndustry
          ? industryMap.get(b.businessIndustry.toString())
          : null,
        categoryNames: (b.businessCategories || [])
          .map((c: any) => categoryMap.get(c.toString()))
          .filter(Boolean),
      }));

      return {
        businesses: enriched,
        total,
        page,
        pages: Math.ceil(total / limit),
      };
    } finally {
      await conn.close();
    }
  }

  // Import selected CVB businesses into a DOP session
  async importCvbBusinesses(payload: {
    sessionId: string;
    businessIds: string[];
    actor: string;
  }): Promise<{
    imported: number;
    skipped: number;
    duplicates: {
      businessId: string;
      name: string;
      existingRecordId: string;
    }[];
  }> {
    const { sessionId, businessIds, actor } = payload;

    const stagingUri = this.configService.get<string>(
      'database.pinntagStaging',
    );
    if (!stagingUri) {
      throw new Error('No URI configured for staging');
    }
    const conn = await mongoose
      .createConnection(stagingUri)
      .asPromise();

    let imported = 0;
    let skipped = 0;
    const duplicates: {
      businessId: string;
      name: string;
      existingRecordId: string;
    }[] = [];

    try {
      const BusinessModel = conn.model(
        'Business',
        new mongoose.Schema({}, { strict: false }),
        'businesses',
      );

      // Fetch the businesses — CVB pool includes crawler-sourced.
      const businesses = await BusinessModel
        .find({
          _id: {
            $in: businessIds.map(
              (id) => new mongoose.Types.ObjectId(id),
            ),
          },
          $or: [{ isCvb: true }, { isFromCrawler: true }],
        })
        .lean() as any[];

      for (const biz of businesses) {
        // Check if already imported in this session
        const existingRecords = await this.recordService
          .findBySession(sessionId, {});

        const alreadyImported = existingRecords.find(
          (r) => r.cvbBusinessId === biz._id.toString(),
        );

        if (alreadyImported) {
          duplicates.push({
            businessId: biz._id.toString(),
            name: biz.name,
            existingRecordId:
              alreadyImported._id.toString(),
          });
          skipped++;
          continue;
        }

        // Create reference record in DOP
        await this.recordService.create({
          sessionId,
          module: 'business',
          rawData: {
            ...biz,
            _cvbSource: true,
            _cvbBusinessId: biz._id.toString(),
          },
          transformedData: {
            name: biz.name,
            phone: biz.phone,
            countryCode: biz.countryCode || '+1',
            email: biz.email,
            website: biz.website,
            placeId: biz.placeId,
            addressLine1: biz.addressLine1,
            addressLine2: biz.addressLine2,
            city: biz.city,
            state: biz.state,
            country: biz.country,
            postalCode: biz.postalCode,
            locality: biz.locality,
            latitude: biz.latitude,
            longitude: biz.longitude,
            rating: biz.rating,
            userRatingCount: biz.userRatingCount,
            logo: biz.logo || null,
            cover: biz.cover || null,
            logoUploaded: biz.logoUploaded || false,
            coverUploaded: biz.coverUploaded || false,
            logoThumbnail: biz.logoThumbnail || null,
            coverThumbnail: biz.coverThumbnail || null,
            tags: biz.tags || [],
            regularTiming: biz.regularTiming,
            businessIndustry: biz.businessIndustry,
            businessCategories: biz.businessCategories,
          },
          status: 'transformed',
          cvbBusinessId: biz._id.toString(),
        });

        imported++;
      }

      // Update session total
      await this.sessionService.updateById(
        sessionId,
        { totalRecords: imported + skipped },
      );

      await this.logService.log({
        sessionId,
        action: SeedingLogActions.CVB_BUSINESSES_IMPORTED,
        actor,
        message:
          `Imported ${imported} CVB businesses ` +
          `(${skipped} skipped as duplicates)`,
      });

    } finally {
      await conn.close();
    }

    return { imported, skipped, duplicates };
  }

  // Get distinct cities from CVB businesses
  async getCvbFilters(): Promise<{
    cities: string[];
    states: string[];
    industries: { _id: string; name: string }[];
    categories: { _id: string; name: string }[];
  }> {
    const stagingUri = this.configService.get<string>(
      'database.pinntagStaging',
    );
    if (!stagingUri) {
      throw new Error('No URI configured for staging');
    }
    const conn = await mongoose
      .createConnection(stagingUri)
      .asPromise();

    try {
      const BusinessModel = conn.model(
        'Business',
        new mongoose.Schema({}, { strict: false }),
        'businesses',
      );

      const db = conn.db!;
      const [cities, states, industries, categories] = await Promise.all([
        BusinessModel.distinct('city', {
          $or: [{ isCvb: true }, { isFromCrawler: true }],
          city: { $nin: [null, ''] },
        }),
        BusinessModel.distinct('state', {
          $or: [{ isCvb: true }, { isFromCrawler: true }],
          state: { $nin: [null, ''] },
        }),
        db
          .collection('businessindustries')
          .find({})
          .project({ _id: 1, name: 1, title: 1, label: 1 })
          .toArray(),
        db
          .collection('businesscategories')
          .find({})
          .project({ _id: 1, name: 1, title: 1, label: 1 })
          .toArray(),
      ]);

      return {
        cities: (cities as string[]).filter(Boolean).sort(),
        states: (states as string[]).filter(Boolean).sort(),
        industries: industries.map((i: any) => ({
          _id: i._id.toString(),
          name: i.name || i.title || i.label || 'Unknown',
        })),
        categories: categories.map((c: any) => ({
          _id: c._id.toString(),
          name: c.name || c.title || c.label || 'Unknown',
        })),
      };
    } finally {
      await conn.close();
    }
  }

  // Validate all records in a CVB session
  async validateCvbSession(payload: {
    sessionId: string;
    actor: string;
  }): Promise<{
    total: number;
    withIssues: number;
    clean: number;
    autoFixable: number;
  }> {
    const { sessionId, actor } = payload;

    const records = await this.recordService
      .findBySessionWithFullData(sessionId, {});

    let withIssues = 0;
    let clean = 0;
    let autoFixable = 0;

    for (const record of records) {
      if (!record.cvbBusinessId) continue;

      const issues = validateCvbBusiness(
        (record.transformedData as any) || {},
      );

      if (issues.length === 0) {
        clean++;
        await this.recordService.updateRecord(
          record._id.toString(),
          {
            status: SeedingRecordStatus.VALIDATED,
            cvbFixes: [],
            validationErrors: [],
          },
        );
      } else {
        withIssues++;
        const safeIssues = issues.filter(
          (i) => i.riskLevel === 'safe' && i.suggestedValue !== null,
        );
        autoFixable += safeIssues.length;

        await this.recordService.updateRecord(
          record._id.toString(),
          {
            status: SeedingRecordStatus.VALIDATED,
            cvbFixes: issues.map((i) => ({
              ...i,
              status: 'pending',
            })),
            validationErrors: issues.map((i) => ({
              field: i.field,
              message: i.issue,
            })),
          },
        );
      }
    }

    await this.logService.log({
      sessionId,
      action: SeedingLogActions.CVB_IMPORT_STARTED,
      actor,
      message:
        `CVB validation complete — ${withIssues} with issues, ` +
        `${clean} clean, ${autoFixable} auto-fixable`,
    });

    return {
      total: records.length,
      withIssues,
      clean,
      autoFixable,
    };
  }

  // Apply a specific fix to a record
  async applyFix(payload: {
    recordId: string;
    field: string;
    value: any;
    actor: string;
    mode: 'manual' | 'auto';
  }): Promise<void> {
    const { recordId, field, value, actor, mode } = payload;

    const record = await this.recordService
      .findByIdWithFullData(recordId);

    if (!record.cvbBusinessId) {
      throw new Error('Not a CVB record');
    }

    const stagingUri = this.configService.get<string>(
      'database.pinntagStaging',
    );
    if (!stagingUri) throw new Error('No staging URI');

    const conn = await mongoose
      .createConnection(stagingUri)
      .asPromise();

    try {
      const BusinessModel = conn.model(
        'Business',
        new mongoose.Schema({}, { strict: false }),
        'businesses',
      );

      const update: Record<string, any> = {};
      if (field === 'coordinates') {
        update.latitude = value.lat;
        update.longitude = value.lng;
        update.location = {
          type: 'Point',
          coordinates: [value.lng, value.lat],
        };
      } else {
        update[field] = value;
      }

      await BusinessModel.updateOne(
        {
          _id: new mongoose.Types.ObjectId(
            record.cvbBusinessId,
          ),
        },
        { $set: update },
      );

      this.logger.log(
        `[CVB] Fix applied: ${field} = ${JSON.stringify(value)} ` +
        `on business ${record.cvbBusinessId}`,
      );
    } finally {
      await conn.close();
    }

    const fixes = (record.cvbFixes || []).map((f: any) => {
      if (f.field === field) {
        return {
          ...f,
          status: 'applied',
          appliedAt: new Date(),
          appliedBy: actor,
          suggestedValue: value,
        };
      }
      return f;
    });

    await this.recordService.updateRecord(recordId, {
      cvbFixes: fixes,
      [`transformedData.${field}`]: value,
    });

    await this.logService.log({
      sessionId: record.sessionId.toString(),
      action: mode === 'auto'
        ? SeedingLogActions.CVB_FIX_AUTO
        : SeedingLogActions.CVB_FIX_APPLIED,
      actor,
      message:
        `Fix applied (${mode}): ${field} on ` +
        `business ${record.cvbBusinessId}`,
    });
  }

  // Reject a fix suggestion
  async rejectFix(payload: {
    recordId: string;
    field: string;
    actor: string;
  }): Promise<void> {
    const { recordId, field, actor } = payload;

    const record = await this.recordService
      .findByIdWithFullData(recordId);

    const fixes = (record.cvbFixes || []).map((f: any) => {
      if (f.field === field) {
        return { ...f, status: 'rejected' };
      }
      return f;
    });

    await this.recordService.updateRecord(recordId, {
      cvbFixes: fixes,
    });

    await this.logService.log({
      sessionId: record.sessionId.toString(),
      action: SeedingLogActions.CVB_FIX_REJECTED,
      actor,
      message: `Fix rejected: ${field} on ${record.cvbBusinessId}`,
    });
  }

  // Auto-fix all safe issues in a session
  async autoFixSession(payload: {
    sessionId: string;
    actor: string;
  }): Promise<{
    fixed: number;
    skipped: number;
  }> {
    const { sessionId, actor } = payload;

    const records = await this.recordService
      .findBySessionWithFullData(sessionId, {});

    let fixed = 0;
    let skipped = 0;

    for (const record of records) {
      if (!record.cvbFixes?.length) continue;

      // Re-read fresh record so we see the latest fix statuses
      // after each applyFix mutation.
      const freshRecord = await this.recordService
        .findByIdWithFullData(record._id.toString());

      for (const fix of (freshRecord.cvbFixes as any[] || [])) {
        this.logger.log(
          `[CVB AUTOFIX] ${freshRecord._id} ` +
          `field=${fix.field} riskLevel=${fix.riskLevel} ` +
          `status=${fix.status} ` +
          `suggestedValue=${JSON.stringify(fix.suggestedValue)}`,
        );

        if (
          fix.riskLevel !== 'safe' ||
          fix.status !== 'pending'
        ) {
          this.logger.warn(
            `[CVB AUTOFIX] SKIPPED ${fix.field} — ` +
            `riskLevel=${fix.riskLevel} status=${fix.status}`,
          );
          skipped++;
          continue;
        }

        if (fix.suggestedValue === '__fetch_from_bot__') {
          await this.recordService.updateRecord(
            freshRecord._id.toString(),
            {
              [`cvbFixes.${fix.field}.status`]: 'pending',
            },
          );
          skipped++;
          continue;
        }

        if (fix.suggestedValue !== null) {
          try {
            await this.applyFix({
              recordId: freshRecord._id.toString(),
              field: fix.field,
              value: fix.suggestedValue,
              actor,
              mode: 'auto',
            });
            fixed++;
          } catch {
            skipped++;
          }
        } else {
          skipped++;
        }
      }
    }

    return { fixed, skipped };
  }
}
