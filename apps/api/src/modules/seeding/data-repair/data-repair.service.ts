import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import {
  EnvironmentUriKey,
  SeedingErrorMessages,
} from '../../../common/constants';
import { OutletCategoryList } from '../../../common/enums';
import {
  buildOutletBaseFromBusiness,
  buildSeededOutletFields,
} from '../activation/seed-defaults';
import {
  DATA_REPAIR_BATCH_SIZE,
  defaultRegularTiming,
  andSeeded,
} from './data-repair.constants';

// Schemaless connection — every target DB write must stay loose because
// the DOP API has no Business/Outlet model registered against the
// remote Mongoose. timestamps:true keeps Mongoose stamping createdAt/
// updatedAt on the docs we insert.
const LOOSE_SCHEMA = new mongoose.Schema<any>(
  {},
  { strict: false, timestamps: true },
);

export interface BadTimingRow {
  _id: string;
  name?: string;
  city?: string;
  state?: string;
  regularTiming: unknown;
}

export interface MissingOutletRow {
  _id: string;
  name?: string;
  city?: string;
  state?: string;
  placeId?: string | null;
  addressLine1?: string;
  address1?: string;
}

export interface FixResult {
  fixed: number;
  skipped: number;
  failed: number;
  errors: { id: string; name?: string; error: string }[];
}

export interface MissingOutletDryRunResult extends FixResult {
  dryRun: true;
  totalSelected: number;
  wouldCreate: {
    businessId: string;
    name?: string;
    outlet: Record<string, any>;
  }[];
}

export interface MissingOutletLiveResult extends FixResult {
  dryRun: false;
  totalSelected: number;
  created: number;
}

// ── FIX 3: Inactive standalone activation ────────────────────────────────

export interface InactiveRow {
  _id: string;
  name?: string;
  addressLine1?: string;
  address1?: string;
  city?: string;
  state?: string;
  placeId?: string | null;
  isActive: boolean;
  outletActive: boolean;
  outletCount: number;
  // Completeness — used by the portal to render ✓/✗ and to drive the
  // "hide incomplete" filter so an operator doesn't activate junk.
  hasHours: boolean;
  hasCover: boolean;
  rating: number | null;
  nameLooksReal: boolean;
}

export interface InactiveListResponse {
  businesses: InactiveRow[];
  total: number;
  page: number;
  pages: number;
}

export interface InactiveActivateDryRun extends FixResult {
  dryRun: true;
  totalSelected: number;
  wouldFlip: {
    businessId: string;
    name?: string;
    flipBusiness: boolean;
    flipOutletIds: string[];
    // Post-flip reconciliation of the business's forward-ref arrays.
    // These are populated whenever activation runs (i.e. anything is
    // being flipped) so the operator UI can preview the corrected
    // outlets[] / activatedOutlets[] before applying. Historically
    // these arrays sometimes carried the business's own _id instead
    // of the real outlet ids; the reconciliation rebuilds them from
    // the truth (outlet.business back-ref).
    wouldOutletsBefore?: string[];
    wouldOutletsAfter?: string[];
    wouldActivatedOutletsBefore?: string[];
    wouldActivatedOutletsAfter?: string[];
    wouldActivatedOutletsLengthBefore?: number;
    wouldActivatedOutletsLengthAfter?: number;
  }[];
}

export interface InactiveActivateLive extends FixResult {
  dryRun: false;
  totalSelected: number;
  activated: number;
}

// ── FIX 4: Taxonomy correction (flag → apply per-row) ────────────────────

export type TaxonomyStatus =
  | 'mismatch'
  | 'unmapped'
  | 'correct'
  | 'no_google_cat';

export type TaxonomyStatusFilter = 'mismatch' | 'unmapped' | 'all';

export interface TaxonomyRow {
  _id: string;
  name?: string;
  placeId?: string | null;
  city?: string;
  state?: string;
  googleCategory?: string | null;
  categoryStatus: TaxonomyStatus | string;
  currentIndustryId?: string | null;
  currentIndustryTitle?: string | null;
  currentCategoryIds: string[];
  currentCategoryTitles: string[];
  proposedIndustryId?: string | null;
  proposedIndustryTitle?: string | null;
  proposedCategoryIds: string[];
  proposedCategoryTitles: string[];
}

export interface TaxonomyListResponse {
  businesses: TaxonomyRow[];
  total: number;
  page: number;
  pages: number;
}

export interface TaxonomyApplyDryRun extends FixResult {
  dryRun: true;
  totalSelected: number;
  wouldApply: {
    businessId: string;
    name?: string;
    fromIndustry?: string | null;
    fromCategories: string[];
    toIndustry?: string | null;
    toCategories: string[];
  }[];
}

export interface TaxonomyApplyLive extends FixResult {
  dryRun: false;
  totalSelected: number;
  applied: number;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

@Injectable()
export class DataRepairService {
  private readonly logger = new Logger(DataRepairService.name);

  constructor(private readonly configService: ConfigService) {}

  // ────────────────────────────────────────────────────────────
  // FIX 1: regularTiming — list + apply default object
  // ────────────────────────────────────────────────────────────

  async listBadRegularTiming(
    environment: string,
    page = 1,
    limit = 25,
  ): Promise<{
    businesses: BadTimingRow[];
    total: number;
    page: number;
    pages: number;
  }> {
    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);
      const filter = this.badRegularTimingFilter();

      const total = await Business.countDocuments(filter);
      const pages = Math.max(1, Math.ceil(total / limit));
      const docs = await Business.find(filter)
        .select('_id name city state regularTiming')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      const businesses: BadTimingRow[] = (docs as any[]).map((d) => ({
        _id: String(d._id),
        name: d.name,
        city: d.city,
        state: d.state,
        regularTiming: d.regularTiming,
      }));

      return { businesses, total, page, pages };
    } finally {
      await conn.close();
    }
  }

  async fixRegularTiming(args: {
    environment: string;
    businessIds?: string[];
    applyAll?: boolean;
    dryRun: boolean;
  }): Promise<FixResult & { dryRun: boolean; totalMatched: number }> {
    const { environment, dryRun } = args;
    const conn = await this.openTargetConn(environment);

    try {
      const Business = this.businessModel(conn);
      const matchFilter = this.badRegularTimingFilter();

      // Selection: explicit ID list takes precedence; applyAll repairs
      // every matching doc. With neither, this is a no-op.
      let selectFilter: Record<string, any>;
      let totalMatched: number;

      if (args.businessIds && args.businessIds.length > 0) {
        const ids = args.businessIds.map(
          (id) => new mongoose.Types.ObjectId(id),
        );
        selectFilter = {
          $and: [matchFilter, { _id: { $in: ids } }],
        };
        totalMatched = await Business.countDocuments(selectFilter);
      } else if (args.applyAll) {
        selectFilter = matchFilter;
        totalMatched = await Business.countDocuments(matchFilter);
      } else {
        return {
          dryRun,
          totalMatched: 0,
          fixed: 0,
          skipped: 0,
          failed: 0,
          errors: [],
        };
      }

      if (dryRun) {
        return {
          dryRun: true,
          totalMatched,
          fixed: totalMatched,
          skipped: 0,
          failed: 0,
          errors: [],
        };
      }

      // Live run: per-batch, per-business writes with try/catch so a
      // single bad doc never aborts the batch.
      const targets = await Business.find(selectFilter)
        .select('_id name')
        .lean();

      let fixed = 0;
      let failed = 0;
      const errors: FixResult['errors'] = [];

      for (const batch of chunk(targets as any[], DATA_REPAIR_BATCH_SIZE)) {
        for (const doc of batch) {
          try {
            const result = await Business.updateOne(
              andSeeded({ _id: doc._id }),
              { $set: { regularTiming: defaultRegularTiming() } },
            );
            if (result.modifiedCount > 0 || result.matchedCount > 0) {
              fixed += 1;
            }
          } catch (err) {
            failed += 1;
            errors.push({
              id: String(doc._id),
              name: doc.name,
              error:
                err instanceof Error
                  ? err.message
                  : 'Unknown regularTiming repair error',
            });
          }
        }
      }

      this.logger.log(
        `[DATA-REPAIR] regularTiming env=${environment} ` +
          `matched=${totalMatched} fixed=${fixed} failed=${failed}`,
      );

      return {
        dryRun: false,
        totalMatched,
        fixed,
        skipped: 0,
        failed,
        errors,
      };
    } finally {
      await conn.close();
    }
  }

  // ────────────────────────────────────────────────────────────
  // FIX 2: missing-outlet — list + create ONE outlet per selection
  // ────────────────────────────────────────────────────────────

  async listMissingOutlet(
    environment: string,
    page = 1,
    limit = 25,
  ): Promise<{
    businesses: MissingOutletRow[];
    total: number;
    page: number;
    pages: number;
  }> {
    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);

      // $lookup outlets, keep only businesses with zero matching outlet
      // docs. Non-deleted filter applied on both sides to avoid surfacing
      // tombstones. Pipeline-based pagination keeps the count and slice
      // in sync. Seeded-only so the missing-outlet queue can't surface
      // organically-created businesses.
      const matchStage = andSeeded({ isDeleted: { $ne: true } });
      const lookupStage = {
        $lookup: {
          from: 'outlets',
          let: { businessId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$business', '$$businessId'] },
                isDeleted: { $ne: true },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: 'outletDocs',
        },
      };
      const missingStage = {
        $match: { 'outletDocs.0': { $exists: false } },
      };

      const totalAgg = await Business.aggregate([
        { $match: matchStage },
        lookupStage,
        missingStage,
        { $count: 'total' },
      ]);
      const total = (totalAgg[0] as any)?.total ?? 0;
      const pages = Math.max(1, Math.ceil(total / limit));

      const pageDocs = await Business.aggregate([
        { $match: matchStage },
        lookupStage,
        missingStage,
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            _id: 1,
            name: 1,
            city: 1,
            state: 1,
            placeId: 1,
            addressLine1: 1,
            address1: 1,
          },
        },
      ]);

      const businesses: MissingOutletRow[] = (pageDocs as any[]).map((d) => ({
        _id: String(d._id),
        name: d.name,
        city: d.city,
        state: d.state,
        placeId: d.placeId ?? null,
        addressLine1: d.addressLine1,
        address1: d.address1,
      }));

      return { businesses, total, page, pages };
    } finally {
      await conn.close();
    }
  }

  async fixMissingOutlet(args: {
    environment: string;
    businessIds: string[];
    dryRun: boolean;
  }): Promise<MissingOutletDryRunResult | MissingOutletLiveResult> {
    const { environment, businessIds, dryRun } = args;

    const totalSelected = businessIds.length;
    if (totalSelected === 0) {
      if (dryRun) {
        return {
          dryRun: true,
          totalSelected: 0,
          fixed: 0,
          skipped: 0,
          failed: 0,
          errors: [],
          wouldCreate: [],
        };
      }
      return {
        dryRun: false,
        totalSelected: 0,
        fixed: 0,
        created: 0,
        skipped: 0,
        failed: 0,
        errors: [],
      };
    }

    const conn = await this.openTargetConn(environment);

    try {
      const Business = this.businessModel(conn);
      const Outlet = this.outletModel(conn);

      // Ensure the 2dsphere index exists on outlets.location — mirrors
      // PostPublishService.activateBusiness. Idempotent.
      try {
        await Outlet.collection.createIndex({ location: '2dsphere' });
      } catch (err) {
        this.logger.warn(
          `[DATA-REPAIR] 2dsphere index creation skipped: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }

      const targets = await Business.find(
        andSeeded({
          _id: {
            $in: businessIds.map((id) => new mongoose.Types.ObjectId(id)),
          },
          isDeleted: { $ne: true },
        }),
      )
        .select(
          '_id name addressLine1 address1 addressLine2 address2 city state ' +
            'postalCode zip country countryCode phone email locality website ' +
            'latitude longitude creator authorisedUser outlets',
        )
        .lean();

      const result: FixResult = {
        fixed: 0,
        skipped: 0,
        failed: 0,
        errors: [],
      };
      const wouldCreate: MissingOutletDryRunResult['wouldCreate'] = [];

      for (const batch of chunk(targets as any[], DATA_REPAIR_BATCH_SIZE)) {
        for (const business of batch) {
          const businessId = String(business._id);
          const businessName = business.name;

          try {
            // Re-check missing-outlet within the live tx window: somebody
            // could have created an outlet between list and repair.
            const existing = await Outlet.countDocuments({
              business: business._id,
              isDeleted: { $ne: true },
            });
            if (existing > 0) {
              result.skipped += 1;
              continue;
            }

            const lng = Number(business.longitude);
            const lat = Number(business.latitude);
            const hasCoords =
              Number.isFinite(lng) &&
              Number.isFinite(lat) &&
              (lng !== 0 || lat !== 0);

            if (!hasCoords) {
              result.failed += 1;
              result.errors.push({
                id: businessId,
                name: businessName,
                error:
                  'Missing coordinates — outlet would be invisible to ' +
                  'consumer $geoNear discovery',
              });
              continue;
            }

            const creatorId =
              business.creator || business.authorisedUser;
            if (!creatorId) {
              result.failed += 1;
              result.errors.push({
                id: businessId,
                name: businessName,
                error:
                  'Business has no creator/authorisedUser — cannot stamp ' +
                  'outlet.creator',
              });
              continue;
            }

            const outletBase = buildOutletBaseFromBusiness(business);
            const outletDoc = buildSeededOutletFields(outletBase, {
              businessId: business._id,
              creatorId,
              category: OutletCategoryList.PHYSICAL,
              longitude: lng,
              latitude: lat,
            });

            if (dryRun) {
              wouldCreate.push({
                businessId,
                name: businessName,
                outlet: outletDoc,
              });
              result.fixed += 1;
              continue;
            }

            const outlet = await Outlet.create(outletDoc);

            // Push outlet + bump counter + flip isActive. NOTE: brief
            // says push to business.outlets + $inc activatedOutletsLength
            // + $set isActive:true ONLY (do NOT touch subscription/drive).
            await Business.updateOne(
              andSeeded({ _id: business._id }),
              {
                $push: { outlets: outlet._id },
                $inc: { activatedOutletsLength: 1 },
                $set: { isActive: true },
              },
            );

            result.fixed += 1;
          } catch (err) {
            result.failed += 1;
            result.errors.push({
              id: businessId,
              name: businessName,
              error:
                err instanceof Error
                  ? err.message
                  : 'Unknown missing-outlet repair error',
            });
          }
        }
      }

      this.logger.log(
        `[DATA-REPAIR] missing-outlet env=${environment} ` +
          `selected=${totalSelected} fixed=${result.fixed} ` +
          `skipped=${result.skipped} failed=${result.failed}`,
      );

      if (dryRun) {
        return {
          dryRun: true,
          totalSelected,
          ...result,
          wouldCreate,
        };
      }

      return {
        dryRun: false,
        totalSelected,
        created: result.fixed,
        ...result,
      };
    } finally {
      await conn.close();
    }
  }

  // ────────────────────────────────────────────────────────────
  // FIX 3: Inactive activation — list + flip business/outlet active
  // ────────────────────────────────────────────────────────────

  // Names matching this pattern are excluded from "real-name" — used by
  // both the per-row `nameLooksReal` signal and the `hideIncomplete`
  // filter. Mirrors the resolve module's JUNK_NAME_RE so the queues
  // agree on what's junk.
  private static readonly JUNK_NAME_RE =
    /(?:test|testing|dummy|sample|asdf|xyzzy)/i;

  async listInactive(args: {
    environment: string;
    page?: number;
    limit?: number;
    city?: string;
    state?: string;
    search?: string;
    // When true, hide rows missing any of: weekDays-shaped hours,
    // non-empty cover, real-looking name. So the operator only sees
    // businesses worth activating.
    hideIncomplete?: boolean;
  }): Promise<InactiveListResponse> {
    const { environment } = args;
    const page = args.page ?? 1;
    // Upper cap raised to 1000 so the portal's "Select all matching"
    // (also capped at 1000) can fetch the full filtered set in one
    // request — keeps the select-all and the activate-batch ceilings
    // consistent. Default page size stays 25.
    const limit = Math.min(args.limit ?? 25, 1000);

    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);

      // ── Build the aggregation pipeline ──
      // Stage shape: match standalone & non-deleted, lookup outlets,
      // compute outletActive + completeness flags, optionally filter
      // by completeness, then $facet for total + page slice. Seeded-
      // only scope appended after operator filters so the count and
      // page slice always reflect seeded-only.
      const baseMatch: Record<string, any> = {
        isDeleted: { $ne: true },
        // Standalone only — satellites are intentionally inactive and
        // must NEVER be surfaced for activation.
        $and: [
          {
            $or: [
              { isLocationOf: { $exists: false } },
              { isLocationOf: null },
            ],
          },
        ],
      };

      if (args.city) {
        baseMatch.$and!.push({
          city: new RegExp(escapeRegex(args.city), 'i'),
        });
      }
      if (args.state) {
        baseMatch.$and!.push({
          state: new RegExp(escapeRegex(args.state), 'i'),
        });
      }
      if (args.search) {
        baseMatch.$and!.push({
          $or: [
            { name: new RegExp(escapeRegex(args.search), 'i') },
            { addressLine1: new RegExp(escapeRegex(args.search), 'i') },
            { placeId: new RegExp(escapeRegex(args.search), 'i') },
          ],
        });
      }
      const scopedMatch = andSeeded(baseMatch);

      const lookupOutlets = {
        $lookup: {
          from: 'outlets',
          let: { bid: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$business', '$$bid'] },
                isDeleted: { $ne: true },
              },
            },
            { $project: { _id: 1, isActive: 1 } },
          ],
          as: 'outletDocs',
        },
      };

      const computeFlags = {
        $addFields: {
          outletCount: { $size: '$outletDocs' },
          // outletActive is true ONLY when there's at least one outlet
          // and every outlet has isActive !== false. A business with
          // zero outlets is treated as outletActive:false (the resolve
          // queue lists them too — they need a sibling fix).
          outletActive: {
            $cond: [
              { $eq: [{ $size: '$outletDocs' }, 0] },
              false,
              {
                $eq: [
                  {
                    $size: {
                      $filter: {
                        input: '$outletDocs',
                        as: 'o',
                        cond: { $eq: ['$$o.isActive', false] },
                      },
                    },
                  },
                  0,
                ],
              },
            ],
          },
          hasHours: {
            $and: [
              { $ne: [{ $type: '$regularTiming' }, 'missing'] },
              { $eq: [{ $type: '$regularTiming.weekDays' }, 'object'] },
            ],
          },
          hasCover: {
            $and: [
              { $eq: [{ $type: '$cover' }, 'string'] },
              { $gt: [{ $strLenCP: { $ifNull: ['$cover', ''] } }, 0] },
            ],
          },
          nameLooksReal: {
            $and: [
              { $eq: [{ $type: '$name' }, 'string'] },
              {
                $gte: [
                  { $strLenCP: { $ifNull: ['$name', ''] } },
                  3,
                ],
              },
              {
                $not: {
                  $regexMatch: {
                    input: { $ifNull: ['$name', ''] },
                    regex: DataRepairService.JUNK_NAME_RE,
                  },
                },
              },
            ],
          },
        },
      };

      // Inactive filter: business OR any outlet is inactive (covers
      // both buckets the diagnostic surfaced — biz+outlet both off,
      // and biz active but outlet off).
      const inactiveFilter = {
        $match: {
          $or: [
            { isActive: false },
            { outletActive: false },
          ],
        },
      };

      const completenessFilter = args.hideIncomplete
        ? [
            {
              $match: {
                hasHours: true,
                hasCover: true,
                nameLooksReal: true,
              },
            },
          ]
        : [];

      const project = {
        $project: {
          _id: 1,
          name: 1,
          addressLine1: 1,
          address1: 1,
          city: 1,
          state: 1,
          placeId: 1,
          isActive: 1,
          outletActive: 1,
          outletCount: 1,
          hasHours: 1,
          hasCover: 1,
          rating: 1,
          nameLooksReal: 1,
          createdAt: 1,
        },
      };

      const pipeline: any[] = [
        { $match: scopedMatch },
        lookupOutlets,
        computeFlags,
        inactiveFilter,
        ...completenessFilter,
      ];

      const totalAgg = await Business.aggregate([
        ...pipeline,
        { $count: 'total' },
      ]);
      const total = (totalAgg[0] as any)?.total ?? 0;
      const pages = Math.max(1, Math.ceil(total / limit));

      const pageDocs = await Business.aggregate([
        ...pipeline,
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        project,
      ]);

      const businesses: InactiveRow[] = (pageDocs as any[]).map((d) => ({
        _id: String(d._id),
        name: d.name,
        addressLine1: d.addressLine1,
        address1: d.address1,
        city: d.city,
        state: d.state,
        placeId: d.placeId ?? null,
        isActive: d.isActive !== false,
        outletActive: d.outletActive === true,
        outletCount: d.outletCount ?? 0,
        hasHours: d.hasHours === true,
        hasCover: d.hasCover === true,
        rating:
          typeof d.rating === 'number' && Number.isFinite(d.rating)
            ? d.rating
            : null,
        nameLooksReal: d.nameLooksReal === true,
      }));

      return { businesses, total, page, pages };
    } finally {
      await conn.close();
    }
  }

  async activateInactive(args: {
    environment: string;
    businessIds: string[];
    dryRun: boolean;
  }): Promise<InactiveActivateDryRun | InactiveActivateLive> {
    const { environment, businessIds, dryRun } = args;
    const totalSelected = businessIds.length;

    if (totalSelected === 0) {
      const empty: FixResult = {
        fixed: 0,
        skipped: 0,
        failed: 0,
        errors: [],
      };
      return dryRun
        ? {
            dryRun: true,
            totalSelected: 0,
            ...empty,
            wouldFlip: [],
          }
        : {
            dryRun: false,
            totalSelected: 0,
            activated: 0,
            ...empty,
          };
    }

    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);
      const Outlet = this.outletModel(conn);

      const oids = businessIds.map(
        (id) => new mongoose.Types.ObjectId(id),
      );

      // Refetch the businesses up-front so we can apply the satellite
      // exclusion and the per-business "needs to flip?" check before
      // any write. Selection by id only — we trust the operator picked
      // these but still revalidate the satellite + isDeleted + seeded
      // guards (the seeded scope drops any id that points at a
      // non-seeded business before we even consider activating it).
      const targets = await Business.find(
        andSeeded({
          _id: { $in: oids },
          isDeleted: { $ne: true },
        }),
      )
        // Pull the forward-ref arrays so the per-business apply can
        // reconcile them post-flip against the outlet collection
        // truth (legacy bug: some businesses carry their own _id in
        // these arrays instead of the real outlet ids).
        .select(
          '_id name isActive isLocationOf outlets activatedOutlets ' +
            'activatedOutletsLength',
        )
        .lean();

      const result: FixResult = {
        fixed: 0,
        skipped: 0,
        failed: 0,
        errors: [],
      };
      const wouldFlip: InactiveActivateDryRun['wouldFlip'] = [];

      for (const batch of chunk(targets as any[], DATA_REPAIR_BATCH_SIZE)) {
        for (const business of batch) {
          const businessId = String(business._id);
          const businessName = business.name;

          try {
            // Hard guard — satellites are isActive:false BY DESIGN and
            // must never be flipped here. The list endpoint already
            // filters them out, but the activate path re-checks in
            // case the operator hand-typed a satellite id.
            if (business.isLocationOf) {
              result.skipped += 1;
              continue;
            }

            const flipBusiness = business.isActive === false;

            const inactiveOutlets = await Outlet.find({
              business: business._id,
              isDeleted: { $ne: true },
              isActive: false,
            })
              .select('_id')
              .lean();

            const flipOutletIds = (inactiveOutlets as any[]).map((o) =>
              String(o._id),
            );

            // Nothing to do for this business — already fully active.
            // Count as skipped so the operator sees it didn't apply.
            if (!flipBusiness && flipOutletIds.length === 0) {
              result.skipped += 1;
              continue;
            }

            // Compute the post-flip forward-ref arrays. The activated
            // outlet ids must end up in business.outlets[] and
            // business.activatedOutlets[] — historically the flow set
            // outlet.isActive:true but never wrote them, leaving the
            // arrays empty even though the outlet was live in-app.
            // $addToSet semantics: preserve whatever's already there
            // (including any legacy wrong ids — those are a separate
            // cleanup) and add the just-flipped ids.
            const outletsBefore = (business.outlets ?? []).map((x: any) =>
              String(x),
            );
            const activatedOutletsBefore = (
              business.activatedOutlets ?? []
            ).map((x: any) => String(x));
            const outletsAfter = Array.from(
              new Set([...outletsBefore, ...flipOutletIds]),
            );
            const activatedOutletsAfter = Array.from(
              new Set([...activatedOutletsBefore, ...flipOutletIds]),
            );
            const lenBefore =
              typeof business.activatedOutletsLength === 'number'
                ? business.activatedOutletsLength
                : activatedOutletsBefore.length;
            const lenAfter = activatedOutletsAfter.length;

            if (dryRun) {
              wouldFlip.push({
                businessId,
                name: businessName,
                flipBusiness,
                flipOutletIds,
                wouldOutletsBefore: outletsBefore,
                wouldOutletsAfter: outletsAfter,
                wouldActivatedOutletsBefore: activatedOutletsBefore,
                wouldActivatedOutletsAfter: activatedOutletsAfter,
                wouldActivatedOutletsLengthBefore: lenBefore,
                wouldActivatedOutletsLengthAfter: lenAfter,
              });
              result.fixed += 1;
              continue;
            }

            // Set BOTH gates true. Consumer-app visibility uses both
            // business.isActive (search/discovery) and outlet.isActive
            // ($geoNear discovery), so flipping just one leaves the
            // business half-visible. Brief explicitly said "set BOTH
            // to be safe unless told otherwise".
            if (flipBusiness) {
              await Business.updateOne(
                andSeeded({
                  _id: business._id,
                  isLocationOf: { $in: [null, undefined] },
                }),
                { $set: { isActive: true } },
              );
            }
            if (flipOutletIds.length > 0) {
              await Outlet.updateMany(
                {
                  business: business._id,
                  isDeleted: { $ne: true },
                  isActive: false,
                },
                { $set: { isActive: true } },
              );

              // Forward-ref reconciliation in two clean steps:
              //   (1) $addToSet the newly-active outlet ids into
              //       outlets[] and activatedOutlets[].
              //   (2) $set activatedOutletsLength to the resolved count
              //       (lenAfter, already computed in JS as the size of
              //       the union of the existing array and flipOutletIds).
              // The two-doc-update form keeps both writes as regular
              // (non-aggregation) updates — Mongoose rejects the pipeline
              // form unless updatePipeline:true is passed, and using a
              // plain number here side-steps that entirely.
              const newOutletOids = flipOutletIds.map(
                (id) => new mongoose.Types.ObjectId(id),
              );
              await Business.updateOne(
                andSeeded({ _id: business._id }),
                {
                  $addToSet: {
                    outlets: { $each: newOutletOids },
                    activatedOutlets: { $each: newOutletOids },
                  },
                },
              );
              await Business.updateOne(
                andSeeded({ _id: business._id }),
                { $set: { activatedOutletsLength: lenAfter } },
              );
            }

            result.fixed += 1;
          } catch (err) {
            result.failed += 1;
            result.errors.push({
              id: businessId,
              name: businessName,
              error:
                err instanceof Error
                  ? err.message
                  : 'Unknown inactive-activation error',
            });
          }
        }
      }

      this.logger.log(
        `[DATA-REPAIR] activate-inactive env=${environment} ` +
          `selected=${totalSelected} fixed=${result.fixed} ` +
          `skipped=${result.skipped} failed=${result.failed}`,
      );

      if (dryRun) {
        return {
          dryRun: true,
          totalSelected,
          ...result,
          wouldFlip,
        };
      }

      return {
        dryRun: false,
        totalSelected,
        activated: result.fixed,
        ...result,
      };
    } finally {
      await conn.close();
    }
  }

  // ────────────────────────────────────────────────────────────
  // FIX 4: Taxonomy correction (resolve sets a flag → operator applies)
  // ────────────────────────────────────────────────────────────

  async listTaxonomy(args: {
    environment: string;
    page?: number;
    limit?: number;
    statusFilter?: TaxonomyStatusFilter;
    city?: string;
    state?: string;
    search?: string;
  }): Promise<TaxonomyListResponse> {
    const { environment } = args;
    const page = args.page ?? 1;
    const limit = Math.min(args.limit ?? 25, 500);
    const statusFilter: TaxonomyStatusFilter =
      args.statusFilter ?? 'mismatch';

    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);

      // Base match: anything the resolve pass has touched (i.e.
      // categoryStatus is set). 'all' surfaces everything; the
      // 'mismatch' / 'unmapped' filters narrow to the actionable
      // buckets the operator cares about.
      const baseMatch: Record<string, any> = {
        isDeleted: { $ne: true },
        categoryStatus: { $exists: true, $ne: null },
      };
      if (statusFilter !== 'all') {
        baseMatch.categoryStatus = statusFilter;
      }

      const andClauses: Record<string, any>[] = [];
      if (args.city) {
        andClauses.push({
          city: new RegExp(escapeRegex(args.city), 'i'),
        });
      }
      if (args.state) {
        andClauses.push({
          state: new RegExp(escapeRegex(args.state), 'i'),
        });
      }
      if (args.search) {
        andClauses.push({
          $or: [
            { name: new RegExp(escapeRegex(args.search), 'i') },
            { placeId: new RegExp(escapeRegex(args.search), 'i') },
            {
              googleCategory: new RegExp(escapeRegex(args.search), 'i'),
            },
          ],
        });
      }
      if (andClauses.length > 0) baseMatch.$and = andClauses;

      // Title resolution via $lookup keeps everything in one round
      // trip. Current categories are an array of ObjectIds; proposed
      // categories are stored as an array of string hexes from the
      // resolve write — coerce both sides to ObjectId for the lookup.
      const lookupIndustry = (
        from: 'businessIndustry' | 'proposedIndustry',
        as: string,
      ) => ({
        $lookup: {
          from: 'businessindustries',
          let: { id: `$${from}` },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: [
                    '$_id',
                    {
                      $cond: [
                        { $eq: [{ $type: '$$id' }, 'objectId'] },
                        '$$id',
                        {
                          $convert: {
                            input: '$$id',
                            to: 'objectId',
                            onError: null,
                            onNull: null,
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            },
            { $project: { _id: 1, name: 1, title: 1 } },
          ],
          as,
        },
      });

      const lookupCategories = (
        from: 'businessCategories' | 'proposedCategories',
        as: string,
      ) => ({
        $lookup: {
          from: 'businesscategories',
          let: { ids: `$${from}` },
          pipeline: [
            {
              $match: {
                $expr: {
                  $in: [
                    '$_id',
                    {
                      $map: {
                        input: { $ifNull: ['$$ids', []] },
                        as: 'i',
                        in: {
                          $cond: [
                            { $eq: [{ $type: '$$i' }, 'objectId'] },
                            '$$i',
                            {
                              $convert: {
                                input: '$$i',
                                to: 'objectId',
                                onError: null,
                                onNull: null,
                              },
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            },
            { $project: { _id: 1, name: 1, title: 1 } },
          ],
          as,
        },
      });

      const pipeline: any[] = [
        { $match: andSeeded(baseMatch) },
        lookupIndustry('businessIndustry', 'currentIndustryDocs'),
        lookupIndustry('proposedIndustry', 'proposedIndustryDocs'),
        lookupCategories('businessCategories', 'currentCategoryDocs'),
        lookupCategories('proposedCategories', 'proposedCategoryDocs'),
      ];

      const totalAgg = await Business.aggregate([
        ...pipeline,
        { $count: 'total' },
      ]);
      const total = (totalAgg[0] as any)?.total ?? 0;
      const pages = Math.max(1, Math.ceil(total / limit));

      const pageDocs = await Business.aggregate([
        ...pipeline,
        { $sort: { updatedAt: -1, createdAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            _id: 1,
            name: 1,
            placeId: 1,
            city: 1,
            state: 1,
            googleCategory: 1,
            categoryStatus: 1,
            businessIndustry: 1,
            businessCategories: 1,
            proposedIndustry: 1,
            proposedCategories: 1,
            currentIndustryDocs: 1,
            proposedIndustryDocs: 1,
            currentCategoryDocs: 1,
            proposedCategoryDocs: 1,
          },
        },
      ]);

      const businesses: TaxonomyRow[] = (pageDocs as any[]).map((d) => {
        const currentIndustryDoc = (d.currentIndustryDocs ?? [])[0];
        const proposedIndustryDoc = (d.proposedIndustryDocs ?? [])[0];
        return {
          _id: String(d._id),
          name: d.name,
          placeId: d.placeId ?? null,
          city: d.city,
          state: d.state,
          googleCategory: d.googleCategory ?? null,
          categoryStatus: d.categoryStatus,
          currentIndustryId: d.businessIndustry
            ? String(d.businessIndustry)
            : null,
          currentIndustryTitle: currentIndustryDoc
            ? currentIndustryDoc.name ?? currentIndustryDoc.title ?? null
            : null,
          currentCategoryIds: Array.isArray(d.businessCategories)
            ? d.businessCategories.map((c: any) => String(c))
            : [],
          currentCategoryTitles: (d.currentCategoryDocs ?? []).map(
            (c: any) => c.name ?? c.title ?? '',
          ),
          proposedIndustryId: d.proposedIndustry
            ? String(d.proposedIndustry)
            : null,
          proposedIndustryTitle: proposedIndustryDoc
            ? proposedIndustryDoc.name ??
              proposedIndustryDoc.title ??
              null
            : null,
          proposedCategoryIds: Array.isArray(d.proposedCategories)
            ? d.proposedCategories.map((c: any) => String(c))
            : [],
          proposedCategoryTitles: (d.proposedCategoryDocs ?? []).map(
            (c: any) => c.name ?? c.title ?? '',
          ),
        };
      });

      return { businesses, total, page, pages };
    } finally {
      await conn.close();
    }
  }

  async applyTaxonomy(args: {
    environment: string;
    businessIds: string[];
    dryRun: boolean;
  }): Promise<TaxonomyApplyDryRun | TaxonomyApplyLive> {
    const { environment, businessIds, dryRun } = args;
    const totalSelected = businessIds.length;

    if (totalSelected === 0) {
      const empty: FixResult = {
        fixed: 0,
        skipped: 0,
        failed: 0,
        errors: [],
      };
      return dryRun
        ? {
            dryRun: true,
            totalSelected: 0,
            ...empty,
            wouldApply: [],
          }
        : {
            dryRun: false,
            totalSelected: 0,
            applied: 0,
            ...empty,
          };
    }

    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);

      const oids = businessIds.map(
        (id) => new mongoose.Types.ObjectId(id),
      );

      const targets = await Business.find(
        andSeeded({
          _id: { $in: oids },
          isDeleted: { $ne: true },
        }),
      )
        .select(
          '_id name categoryStatus businessIndustry businessCategories ' +
            'proposedIndustry proposedCategories',
        )
        .lean();

      const result: FixResult = {
        fixed: 0,
        skipped: 0,
        failed: 0,
        errors: [],
      };
      const wouldApply: TaxonomyApplyDryRun['wouldApply'] = [];

      for (const batch of chunk(targets as any[], DATA_REPAIR_BATCH_SIZE)) {
        for (const business of batch) {
          const businessId = String(business._id);
          const businessName = business.name;

          try {
            // Skip-if-not-actionable: only 'mismatch' rows with a
            // valid proposed* pair get flipped. Everything else is
            // already correct, unmapped (no proposal exists), or
            // missing a category entirely. Re-check status on the
            // live doc in case it was re-resolved since the operator
            // picked it.
            if (business.categoryStatus !== 'mismatch') {
              result.skipped += 1;
              continue;
            }
            if (
              !business.proposedIndustry ||
              !Array.isArray(business.proposedCategories) ||
              business.proposedCategories.length === 0
            ) {
              result.skipped += 1;
              continue;
            }

            const fromIndustry = business.businessIndustry
              ? String(business.businessIndustry)
              : null;
            const fromCategories = Array.isArray(business.businessCategories)
              ? business.businessCategories.map((c: any) => String(c))
              : [];
            const toIndustry = String(business.proposedIndustry);
            const toCategories = business.proposedCategories.map(
              (c: any) => String(c),
            );

            if (dryRun) {
              wouldApply.push({
                businessId,
                name: businessName,
                fromIndustry,
                fromCategories,
                toIndustry,
                toCategories,
              });
              result.fixed += 1;
              continue;
            }

            // Live: set the taxonomy to the proposed values, mark
            // status as 'correct', drop the proposed* fields. ObjectId
            // coercion mirrors how the live business doc stores them
            // so the schema stays consistent.
            const industryOid = new mongoose.Types.ObjectId(toIndustry);
            const categoryOids = toCategories.map(
              (id: string) => new mongoose.Types.ObjectId(id),
            );

            await Business.updateOne(
              andSeeded({ _id: business._id }),
              {
                $set: {
                  businessIndustry: industryOid,
                  businessCategories: categoryOids,
                  categoryStatus: 'correct',
                },
                $unset: {
                  proposedIndustry: '',
                  proposedCategories: '',
                },
              },
            );

            result.fixed += 1;
          } catch (err) {
            result.failed += 1;
            result.errors.push({
              id: businessId,
              name: businessName,
              error:
                err instanceof Error
                  ? err.message
                  : 'Unknown taxonomy apply error',
            });
          }
        }
      }

      this.logger.log(
        `[DATA-REPAIR] apply-taxonomy env=${environment} ` +
          `selected=${totalSelected} fixed=${result.fixed} ` +
          `skipped=${result.skipped} failed=${result.failed}`,
      );

      if (dryRun) {
        return {
          dryRun: true,
          totalSelected,
          ...result,
          wouldApply,
        };
      }
      return {
        dryRun: false,
        totalSelected,
        applied: result.fixed,
        ...result,
      };
    } finally {
      await conn.close();
    }
  }

  // ────────────────────────────────────────────────────────────
  // ── ADDRESS CORRUPTION DETECTOR ─────────────────────────────────
  //
  // Operator-facing query: find businesses whose stored address fields
  // structurally disagree with themselves (US state + non-US coords,
  // digits-only city, etc.) so they can be re-resolved to capture a
  // googleFormattedAddress that the parser can then turn into a
  // proposedAddress. This is independent of the parser pipeline — it
  // works on the LIVE address fields, no googleFormattedAddress
  // required, so corruption can be surfaced before any resolve pass.
  //
  // The four signature definitions mirror Stage B's import-time guards
  // in scraper-adapter.ts so behaviour stays consistent between
  // import-time flagging and live-detection scanning.

  async listAddressCorrupt(args: {
    environment: string;
    page?: number;
    limit?: number;
    signature?: AddressCorruptSignature | 'all';
    city?: string;
    state?: string;
  }): Promise<AddressCorruptListResponse> {
    const { environment } = args;
    const page = Math.max(1, args.page ?? 1);
    const limit = Math.min(Math.max(1, args.limit ?? 25), 100);
    const signature = args.signature ?? 'all';

    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);

      // Pre-aggregation match — cheap field-level filters first so the
      // expensive $expr only runs on the smaller candidate set.
      const baseMatch: Record<string, any> = {
        isDeleted: { $ne: true },
      };
      if (args.city) {
        baseMatch.city = new RegExp(escapeRegex(args.city), 'i');
      }
      if (args.state) {
        baseMatch.state = new RegExp(escapeRegex(args.state), 'i');
      }

      const pipeline: Record<string, any>[] = [
        // Seeded-only scope applied at the FIRST stage so the displayed
        // total (counted later in the $facet) and the page slice both
        // reflect seeded-only. Otherwise a non-seeded business with a
        // corrupt-looking field would inflate the operator's queue.
        { $match: andSeeded(baseMatch) },
        // Compute the four signatures per doc as conditional strings;
        // $filter then drops the nulls so the resulting array carries
        // only the signatures that actually fired.
        {
          $addFields: {
            _sigs: {
              $filter: {
                input: [
                  ADDRESS_CORRUPT_SIG_EXPRS.us_state_non_us_coords,
                  ADDRESS_CORRUPT_SIG_EXPRS.digits_only_city,
                  ADDRESS_CORRUPT_SIG_EXPRS.plus1_non_us_coords,
                  ADDRESS_CORRUPT_SIG_EXPRS.missing_country_with_addr,
                ],
                as: 's',
                cond: { $ne: ['$$s', null] },
              },
            },
          },
        },
        // Keep only docs that actually fired a signature.
        { $match: { '_sigs.0': { $exists: true } } },
      ];
      if (signature !== 'all') {
        pipeline.push({ $match: { _sigs: signature } });
      }

      // Facet for total + page slice in a single round trip.
      pipeline.push({
        $facet: {
          total: [{ $count: 'count' }],
          page: [
            { $sort: { _id: 1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                _id: 1,
                name: 1,
                address1: 1,
                addressLine1: 1,
                city: 1,
                state: 1,
                postalCode: 1,
                country: 1,
                countryCode: 1,
                latitude: 1,
                longitude: 1,
                googleFormattedAddress: 1,
                addressStatus: 1,
                _sigs: 1,
              },
            },
          ],
        },
      });

      // Cast through unknown — mongoose's PipelineStage union enumerates
      // every stage flavour (including $vectorSearch) and our locally-
      // built Record<string,any>[] doesn't satisfy the discriminated
      // union check. Runtime shape is correct; this is purely a type-
      // narrowing escape hatch matching the rest of the codebase's
      // loose-aggregation pattern.
      const raw = (await Business.aggregate(
        pipeline as unknown as mongoose.PipelineStage[],
      )) as Array<{
        total: { count: number }[];
        page: any[];
      }>;
      const total = raw[0]?.total?.[0]?.count ?? 0;
      const pageDocs = raw[0]?.page ?? [];
      const pages = Math.max(1, Math.ceil(total / limit));

      const businesses: AddressCorruptRow[] = pageDocs.map((d) => ({
        _id: String(d._id),
        name: d.name ?? '',
        address1: trimStr(d.address1 ?? d.addressLine1 ?? ''),
        city: trimStr(d.city),
        state: trimStr(d.state),
        postalCode: trimStr(d.postalCode),
        country: trimStr(d.country),
        countryCode: trimStr(d.countryCode),
        latitude:
          typeof d.latitude === 'number' && Number.isFinite(d.latitude)
            ? d.latitude
            : null,
        longitude:
          typeof d.longitude === 'number' && Number.isFinite(d.longitude)
            ? d.longitude
            : null,
        signatures: Array.isArray(d._sigs)
          ? (d._sigs as AddressCorruptSignature[])
          : [],
        // Drives the "needs re-resolve" vs "ready to parse" badge in the
        // operator UI — anyone without a captured raw address can't be
        // fed to libpostal yet.
        needsResolve: !(
          typeof d.googleFormattedAddress === 'string' &&
          d.googleFormattedAddress.trim().length > 0
        ),
        googleFormattedAddress:
          typeof d.googleFormattedAddress === 'string'
            ? d.googleFormattedAddress
            : null,
        addressStatus:
          typeof d.addressStatus === 'string' ? d.addressStatus : null,
      }));

      return { businesses, total, page, pages };
    } finally {
      await conn.close();
    }
  }

  // Operator-facing query: find OUTLETS whose own address fields
  // contradict their own coords/phone. Mirrors listAddressCorrupt for
  // businesses but runs against the outlets collection — outlets are
  // independent physical locations from their parent (e.g. "Discover
  // Atlanta 1" parent = Mercedes-Benz Stadium, outlet "Alliance
  // Theatre" = 1280 Peachtree St). So an outlet is corrupt iff ITS OWN
  // address disagrees with ITS OWN coords/phone, regardless of what
  // the parent business carries.
  //
  // The four ADDRESS_CORRUPT_SIG_EXPRS reference $state, $country,
  // $city, $countryCode, $latitude, $longitude — every one of those is
  // present on the outlet schema with identical semantics, so the
  // expressions reuse verbatim.
  //
  // Seeded scope: outlets carry `isFromCrawler: true` when they come
  // from buildSeededOutletFields (see seed-defaults.ts), so we filter
  // on that directly. There's no isCvb on outlet — CVB-derived
  // outlets are activated through the same buildSeededOutletFields
  // path and therefore also carry isFromCrawler:true.
  //
  // No apply endpoint here — fixing a corrupt outlet means re-resolving
  // the outlet from its OWN name+address via Google to capture
  // outlet.googleFormattedAddress, then running libpostal, then
  // applying to the outlet's own fields (parallel to the business
  // resolve → address-parse → apply flow, not a parent copy).
  async listAddressCorruptOutlets(args: {
    environment: string;
    page?: number;
    limit?: number;
    signature?: AddressCorruptSignature | 'all';
    city?: string;
    state?: string;
  }): Promise<OutletAddressCorruptListResponse> {
    const { environment } = args;
    const page = Math.max(1, args.page ?? 1);
    const limit = Math.min(Math.max(1, args.limit ?? 25), 100);
    const signature = args.signature ?? 'all';

    const conn = await this.openTargetConn(environment);
    try {
      const Outlet = this.outletModel(conn);

      const baseMatch: Record<string, any> = {
        isDeleted: { $ne: true },
        // Seeded-only scope on the outlet side. isFromCrawler is
        // hard-set true by buildSeededOutletFields for every outlet the
        // seeding pipeline produces (both crawler-imported and CVB-
        // imported), so it's the safe single-flag check on outlets —
        // we don't need to $lookup the parent business.
        isFromCrawler: true,
      };
      if (args.city) {
        baseMatch.city = new RegExp(escapeRegex(args.city), 'i');
      }
      if (args.state) {
        baseMatch.state = new RegExp(escapeRegex(args.state), 'i');
      }

      const pipeline: Record<string, any>[] = [
        { $match: baseMatch },
        {
          $addFields: {
            _sigs: {
              $filter: {
                input: [
                  ADDRESS_CORRUPT_SIG_EXPRS.us_state_non_us_coords,
                  ADDRESS_CORRUPT_SIG_EXPRS.digits_only_city,
                  ADDRESS_CORRUPT_SIG_EXPRS.plus1_non_us_coords,
                  ADDRESS_CORRUPT_SIG_EXPRS.missing_country_with_addr,
                ],
                as: 's',
                cond: { $ne: ['$$s', null] },
              },
            },
          },
        },
        { $match: { '_sigs.0': { $exists: true } } },
      ];
      if (signature !== 'all') {
        pipeline.push({ $match: { _sigs: signature } });
      }

      // Surface the parent business name so the operator UI can show
      // "[business] → [outlet]" context. Drop the lookup array down to
      // the single name field to keep the payload small.
      pipeline.push({
        $lookup: {
          from: 'businesses',
          let: { bid: '$business' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$bid'] } } },
            { $project: { _id: 1, name: 1 } },
          ],
          as: '_business',
        },
      });

      pipeline.push({
        $facet: {
          total: [{ $count: 'count' }],
          page: [
            { $sort: { _id: 1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                _id: 1,
                name: 1,
                business: 1,
                address1: 1,
                city: 1,
                state: 1,
                postalCode: 1,
                country: 1,
                countryCode: 1,
                latitude: 1,
                longitude: 1,
                // Outlets don't currently carry googleFormattedAddress
                // or addressStatus (those live on business), but the
                // fix pipeline will introduce them — surface them now
                // so the UI is forward-compatible. Both fields fall
                // back to null/'needs resolve' below when missing.
                googleFormattedAddress: 1,
                addressStatus: 1,
                _sigs: 1,
                _business: 1,
              },
            },
          ],
        },
      });

      const raw = (await Outlet.aggregate(
        pipeline as unknown as mongoose.PipelineStage[],
      )) as Array<{
        total: { count: number }[];
        page: any[];
      }>;
      const total = raw[0]?.total?.[0]?.count ?? 0;
      const pageDocs = raw[0]?.page ?? [];
      const pages = Math.max(1, Math.ceil(total / limit));

      const outlets: OutletAddressCorruptRow[] = pageDocs.map((d) => {
        const parent = Array.isArray(d._business)
          ? d._business[0]
          : undefined;
        return {
          _id: String(d._id),
          name: d.name ?? '',
          businessId: d.business ? String(d.business) : null,
          businessName: parent?.name ?? null,
          address1: trimStr(d.address1),
          city: trimStr(d.city),
          state: trimStr(d.state),
          postalCode: trimStr(d.postalCode),
          country: trimStr(d.country),
          countryCode: trimStr(d.countryCode),
          latitude:
            typeof d.latitude === 'number' && Number.isFinite(d.latitude)
              ? d.latitude
              : null,
          longitude:
            typeof d.longitude === 'number' && Number.isFinite(d.longitude)
              ? d.longitude
              : null,
          signatures: Array.isArray(d._sigs)
            ? (d._sigs as AddressCorruptSignature[])
            : [],
          // True when the outlet has no captured raw address yet — the
          // bot needs to re-resolve from outlet name+address before
          // libpostal can act on it (the fix flow).
          needsResolve: !(
            typeof d.googleFormattedAddress === 'string' &&
            d.googleFormattedAddress.trim().length > 0
          ),
          googleFormattedAddress:
            typeof d.googleFormattedAddress === 'string'
              ? d.googleFormattedAddress
              : null,
          addressStatus:
            typeof d.addressStatus === 'string' ? d.addressStatus : null,
        };
      });

      return { outlets, total, page, pages };
    } finally {
      await conn.close();
    }
  }

  // Internals
  // ────────────────────────────────────────────────────────────

  private async openTargetConn(
    environment: string,
  ): Promise<mongoose.Connection> {
    const uriKey =
      EnvironmentUriKey[environment as keyof typeof EnvironmentUriKey];
    const uri = uriKey
      ? this.configService.get<string>(uriKey)
      : undefined;
    if (!uri) {
      throw new Error(SeedingErrorMessages.missingTargetUri(environment));
    }
    return mongoose.createConnection(uri).asPromise();
  }

  private businessModel(conn: mongoose.Connection): mongoose.Model<any> {
    return (
      conn.models['DataRepairBusiness'] ||
      conn.model('DataRepairBusiness', LOOSE_SCHEMA, 'businesses')
    );
  }

  private outletModel(conn: mongoose.Connection): mongoose.Model<any> {
    return (
      conn.models['DataRepairOutlet'] ||
      conn.model('DataRepairOutlet', LOOSE_SCHEMA, 'outlets')
    );
  }

  // Matches "regularTiming is not an object": missing, null, or a
  // primitive (the legacy `regularTiming: 0` case). $not + $type:'object'
  // covers all three. Scoped to seeded-only so the opening-hours tab
  // can't surface or repair organically-created businesses.
  private badRegularTimingFilter(): Record<string, any> {
    return andSeeded({
      isDeleted: { $ne: true },
      $or: [
        { regularTiming: { $exists: false } },
        { regularTiming: null },
        { regularTiming: { $not: { $type: 'object' } } },
      ],
    });
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

// ─── Address-corruption signatures ──────────────────────────────────────
//
// These mirror the Stage B import-validation guards in
// scraper-adapter.ts:appendStageBValidationWarnings so the operator-
// facing live-detection scan reports the same kinds of corruption that
// scraper-import would have flagged at write time. Keep the predicates
// in lock-step — if you change one side, change the other.

export type AddressCorruptSignature =
  | 'us_state_non_us_coords'
  | 'digits_only_city'
  | 'plus1_non_us_coords'
  | 'missing_country_with_addr';

export interface AddressCorruptRow {
  _id: string;
  name: string;
  address1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  signatures: AddressCorruptSignature[];
  // True when no googleFormattedAddress has been captured yet — the
  // operator should re-resolve before the parser can act on this row.
  needsResolve: boolean;
  googleFormattedAddress: string | null;
  addressStatus: string | null;
}

export interface AddressCorruptListResponse {
  businesses: AddressCorruptRow[];
  total: number;
  page: number;
  pages: number;
}

// Mirrors AddressCorruptRow but on the outlets collection. The four
// signatures are identical (same ADDRESS_CORRUPT_SIG_EXPRS, same shape
// of corruption); the row carries the parent business id + name so
// the operator UI can show "[business] → [outlet]" without an extra
// round trip.
export interface OutletAddressCorruptRow {
  _id: string;
  name: string;
  businessId: string | null;
  businessName: string | null;
  address1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  signatures: AddressCorruptSignature[];
  // True when no googleFormattedAddress has been captured on the
  // outlet yet — the bot needs to re-resolve from the outlet's own
  // name+address before libpostal can act on it.
  needsResolve: boolean;
  googleFormattedAddress: string | null;
  addressStatus: string | null;
}

export interface OutletAddressCorruptListResponse {
  outlets: OutletAddressCorruptRow[];
  total: number;
  page: number;
  pages: number;
}

// Lowercased canonical list of every US state in BOTH 2-letter abbrev
// and full-name form. The $expr below applies $toLower to the stored
// state value before $in-checking, which handles "NY"/"Ny"/"ny"/"New
// York"/"new york"/"NEW YORK" with a single 102-entry list instead of
// enumerating every casing.
const US_STATE_NAMES_LC: readonly string[] = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'district of columbia', 'florida', 'georgia',
  'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
  'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska',
  'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york',
  'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
  'west virginia', 'wisconsin', 'wyoming',
];
const US_STATE_ABBRS_LC: readonly string[] = [
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'dc', 'fl', 'ga',
  'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma',
  'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny',
  'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx',
  'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy',
];
const US_STATE_FORMS_LC: readonly string[] = [
  ...US_STATE_NAMES_LC,
  ...US_STATE_ABBRS_LC,
];

// US bbox check — matches the isUsCoord helper in scraper-adapter.ts.
// Continental US + Alaska + Hawaii loose boxes. Loose on purpose: a
// near-miss is a false negative (no flag), which is harmless; the
// other direction would flag a legitimate US business as corrupt.
const US_BBOX_EXPR = {
  $or: [
    // Continental
    {
      $and: [
        { $gte: ['$latitude', 24] },
        { $lte: ['$latitude', 50] },
        { $gte: ['$longitude', -125] },
        { $lte: ['$longitude', -66] },
      ],
    },
    // Alaska
    {
      $and: [
        { $gte: ['$latitude', 51] },
        { $lte: ['$latitude', 72] },
        { $gte: ['$longitude', -180] },
        { $lte: ['$longitude', -130] },
      ],
    },
    // Hawaii
    {
      $and: [
        { $gte: ['$latitude', 18] },
        { $lte: ['$latitude', 23] },
        { $gte: ['$longitude', -161] },
        { $lte: ['$longitude', -154] },
      ],
    },
  ],
};

// Coords are "set" when they're non-null AND not the (0, 0) sentinel.
// scraper-adapter defaults missing coords to (0, 0) so we must mirror
// that here — flagging (0, 0) as non-US would false-positive every
// import that didn't carry lat/lng.
const HAS_COORDS_EXPR = {
  $and: [
    { $ne: [{ $ifNull: ['$latitude', null] }, null] },
    { $ne: [{ $ifNull: ['$longitude', null] }, null] },
    {
      $or: [
        { $ne: ['$latitude', 0] },
        { $ne: ['$longitude', 0] },
      ],
    },
  ],
};

// Per-signature $cond returning the signature name when fired, null
// otherwise. Composed into the $filter input in listAddressCorrupt.
const ADDRESS_CORRUPT_SIG_EXPRS: Record<
  AddressCorruptSignature,
  Record<string, any>
> = {
  // US state value (any case, abbrev or full name) with coordinates
  // that point outside the United States — strongest contradiction
  // and the original brief's motivating example.
  us_state_non_us_coords: {
    $cond: [
      {
        $and: [
          {
            $in: [
              { $toLower: { $ifNull: ['$state', ''] } },
              US_STATE_FORMS_LC,
            ],
          },
          HAS_COORDS_EXPR,
          { $not: US_BBOX_EXPR },
        ],
      },
      'us_state_non_us_coords',
      null,
    ],
  },

  // City is a non-empty string of all digits — usually a postcode that
  // slid into the city field during a sloppy import.
  digits_only_city: {
    $cond: [
      {
        $regexMatch: {
          input: { $ifNull: ['$city', ''] },
          regex: '^\\d+$',
        },
      },
      'digits_only_city',
      null,
    ],
  },

  // countryCode="+1" but coordinates fall outside the US — likely the
  // scraper-adapter's parsePhone default leaking onto a non-US doc.
  plus1_non_us_coords: {
    $cond: [
      {
        $and: [
          { $eq: ['$countryCode', '+1'] },
          HAS_COORDS_EXPR,
          { $not: US_BBOX_EXPR },
        ],
      },
      'plus1_non_us_coords',
      null,
    ],
  },

  // Country field empty/missing while state or city carries something.
  // Catches imports that dropped the country anchor entirely.
  missing_country_with_addr: {
    $cond: [
      {
        $and: [
          {
            $or: [
              { $eq: [{ $type: '$country' }, 'missing'] },
              { $eq: ['$country', null] },
              { $eq: [{ $ifNull: ['$country', ''] }, ''] },
            ],
          },
          {
            $or: [
              { $ne: [{ $ifNull: ['$state', ''] }, ''] },
              { $ne: [{ $ifNull: ['$city', ''] }, ''] },
            ],
          },
        ],
      },
      'missing_country_with_addr',
      null,
    ],
  },
};
