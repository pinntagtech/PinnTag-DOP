import { Injectable, Logger } from '@nestjs/common';
import mongoose from 'mongoose';
import { GateService } from './gate.service';
import { GATE_CRITERIA } from './gate-predicates';
import { buildSeededFilter } from '../common/seeded-cohort';
import {
  ConsoleBusinessRow,
  ConsoleFacetsRequest,
  ConsoleFacetsResponse,
  ConsoleFilter,
  ConsoleSearchRequest,
  ConsoleSearchResponse,
} from './console.types';

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

// Row projection kept intentionally small — the table shows a handful of
// columns and hover tooltips; a detail endpoint can be added later if we
// need the full doc.
const ROW_PROJECTION = {
  _id: 1,
  name: 1,
  city: 1,
  state: 1,
  isActive: 1,
  cover: 1,
  coverThumbnail: 1,
  website: 1,
  email: 1,
  addressLine1: 1,
  placeId: 1,
  resolveStatus: 1,
  gateStatus: 1,
  emailVerification: 1,
  createdAt: 1,
  updatedAt: 1,
} as const;

@Injectable()
export class ConsoleService {
  private readonly logger = new Logger(ConsoleService.name);

  constructor(private readonly gateService: GateService) {}

  // ── Search ────────────────────────────────────────────────────────────
  async search(req: ConsoleSearchRequest): Promise<ConsoleSearchResponse> {
    const page = Math.max(1, req.page ?? 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, req.pageSize ?? DEFAULT_PAGE_SIZE),
    );
    const sortField = req.sort?.field ?? 'name';
    const sortDir = req.sort?.dir === 'desc' ? -1 : 1;

    const conn = await this.gateService.openConnection(req.environment);
    try {
      const businesses = conn.collection('businesses');
      const mongoFilter = await this.buildMongoFilter(
        businesses,
        req.filter ?? {},
      );

      const total = await businesses.countDocuments(mongoFilter);
      const items = (await businesses
        .find(mongoFilter, { projection: ROW_PROJECTION })
        .sort({ [sortField]: sortDir })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray()) as any[];

      return {
        items: items.map((d) => this.toRow(d)),
        total,
        page,
        pageSize,
      };
    } finally {
      await conn.close();
    }
  }

  // ── Facets ────────────────────────────────────────────────────────────
  //
  // For each of the 10 criteria, count docs (under the current filter)
  // that FAIL that criterion. Also returns passLegacy9/passPerfect11 and
  // total. Single aggregation — one round-trip.
  async facets(req: ConsoleFacetsRequest): Promise<ConsoleFacetsResponse> {
    const conn = await this.gateService.openConnection(req.environment);
    try {
      const businesses = conn.collection('businesses');
      const mongoFilter = await this.buildMongoFilter(
        businesses,
        req.filter ?? {},
      );

      const groupBody: Record<string, any> = {
        _id: null,
        total: { $sum: 1 },
        passLegacy9: {
          $sum: { $cond: ['$gateStatus.passLegacy9', 1, 0] },
        },
        passPerfect11: {
          $sum: { $cond: ['$gateStatus.passPerfect11', 1, 0] },
        },
      };
      for (const c of GATE_CRITERIA) {
        // Fail = criterion is falsy. Missing gateStatus → treat as fail.
        groupBody[`fail_${c}`] = {
          $sum: {
            $cond: [{ $eq: [`$gateStatus.${c}`, true] }, 0, 1],
          },
        };
      }

      const [agg] = (await businesses
        .aggregate([{ $match: mongoFilter }, { $group: groupBody }])
        .toArray()) as Array<Record<string, any>>;

      const failByCriterion: Record<string, number> = {};
      for (const c of GATE_CRITERIA) {
        failByCriterion[c] = agg?.[`fail_${c}`] ?? 0;
      }

      return {
        totals: {
          total: agg?.total ?? 0,
          passLegacy9: agg?.passLegacy9 ?? 0,
          passPerfect11: agg?.passPerfect11 ?? 0,
        },
        failByCriterion,
      };
    } finally {
      await conn.close();
    }
  }

  // ── Filter builder ────────────────────────────────────────────────────
  //
  // Always ANDs the seeded-only clause. Everything user-provided is
  // additive. duplicatePlaceIdOnly runs a small aggregation to find
  // placeIds with count > 1 in the seeded set, then AND-ins a placeId
  // $in clause; no dupes → filter narrows to an impossible clause so
  // the result is an empty page rather than a silent full corpus.
  private async buildMongoFilter(
    businesses: mongoose.mongo.Collection,
    filter: ConsoleFilter,
  ): Promise<Record<string, any>> {
    const clauses: any[] = [buildSeededFilter()];

    if (filter.q) {
      const q = filter.q.trim();
      if (q) {
        // Regex-escape the input before wrapping it so the user can
        // safely paste an address or email without triggering "invalid
        // regex" errors on stray parens.
        const rx = new RegExp(
          q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          'i',
        );
        clauses.push({
          $or: [
            { name: rx },
            { addressLine1: rx },
            { placeId: rx },
            { email: rx },
          ],
        });
      }
    }
    if (filter.state?.length) clauses.push({ state: { $in: filter.state } });
    if (filter.city?.length) clauses.push({ city: { $in: filter.city } });
    if (filter.industry?.length)
      clauses.push({ businessIndustry: { $in: filter.industry } });
    if (filter.category?.length)
      clauses.push({ businessCategories: { $in: filter.category } });
    if (typeof filter.isActive === 'boolean')
      clauses.push({ isActive: filter.isActive });
    if (typeof filter.hasWebsite === 'boolean') {
      clauses.push(
        filter.hasWebsite
          ? { website: { $exists: true, $nin: [null, ''] } }
          : {
              $or: [
                { website: null },
                { website: '' },
                { website: { $exists: false } },
              ],
            },
      );
    }
    if (typeof filter.hasEmail === 'boolean') {
      clauses.push(
        filter.hasEmail
          ? { email: { $exists: true, $nin: [null, ''] } }
          : {
              $or: [
                { email: null },
                { email: '' },
                { email: { $exists: false } },
              ],
            },
      );
    }
    if (filter.resolveHoursStatus?.length) {
      clauses.push({
        'resolveStatus.hours': { $in: filter.resolveHoursStatus },
      });
    }

    if (filter.gateFails?.length) {
      for (const c of this.filterGateCriteria(filter.gateFails)) {
        clauses.push({
          $or: [
            { [`gateStatus.${c}`]: false },
            { [`gateStatus.${c}`]: { $exists: false } },
            { gateStatus: { $exists: false } },
          ],
        });
      }
    }
    if (filter.gatePasses?.length) {
      for (const c of this.filterGateCriteria(filter.gatePasses)) {
        clauses.push({ [`gateStatus.${c}`]: true });
      }
    }
    if (filter.gateOverall === 'passLegacy9') {
      clauses.push({ 'gateStatus.passLegacy9': true });
    } else if (filter.gateOverall === 'passPerfect11') {
      clauses.push({ 'gateStatus.passPerfect11': true });
    } else if (filter.gateOverall === 'failAny') {
      clauses.push({
        $or: [
          { 'gateStatus.passLegacy9': { $ne: true } },
          { 'gateStatus.passLegacy9': { $exists: false } },
        ],
      });
    }

    if (filter.duplicatePlaceIdOnly) {
      const dupePlaceIds = await this.duplicatePlaceIdSet(businesses);
      clauses.push(
        dupePlaceIds.length
          ? { placeId: { $in: dupePlaceIds } }
          : { _id: null }, // no dupes → empty result on purpose
      );
    }

    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  }

  private filterGateCriteria(input: string[] | undefined): string[] {
    if (!input?.length) return [];
    const valid = new Set<string>(GATE_CRITERIA);
    return input.filter((c) => valid.has(c));
  }

  private async duplicatePlaceIdSet(
    businesses: mongoose.mongo.Collection,
  ): Promise<string[]> {
    const groups = (await businesses
      .aggregate(
        [
          {
            $match: {
              ...buildSeededFilter(),
              placeId: { $type: 'string', $ne: '' },
            },
          },
          { $group: { _id: '$placeId', count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $project: { _id: 1 } },
        ],
        { allowDiskUse: true },
      )
      .toArray()) as Array<{ _id: string }>;
    return groups.map((g) => g._id).filter(Boolean);
  }

  private toRow(d: any): ConsoleBusinessRow {
    return {
      _id: String(d._id),
      name: d.name ?? null,
      city: d.city ?? null,
      state: d.state ?? null,
      isActive: d.isActive === true,
      cover: d.cover ?? null,
      coverThumbnail: d.coverThumbnail ?? null,
      website: d.website ?? null,
      email: d.email ?? null,
      addressLine1: d.addressLine1 ?? null,
      placeId: d.placeId ?? null,
      resolveStatus: d.resolveStatus ?? null,
      gateStatus: d.gateStatus ?? null,
      emailVerification: d.emailVerification ?? null,
    };
  }
}
