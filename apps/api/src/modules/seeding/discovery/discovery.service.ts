import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import mongoose, { Model } from 'mongoose';
import {
  DiscoveryRegion,
  DiscoveryRegionDocument,
} from './schemas/discovery-region.schema';
import { buildSeededFilter } from '../common/seeded-cohort';
import {
  fetchOverturePlacesInBbox,
  OvertureCandidate,
} from './overture-client';
import {
  haversineMeters,
  metersToLatDeg,
  metersToLngDeg,
  nameSimilarity,
  normalizeName,
} from './dedup-helpers';
import { REGION_SEED_DATA } from './region-seed-data';
import { isBlockedOvertureCategory } from './category-blocklist';
import {
  resolvePlaceIdBySearchText,
  PlacesResolveResult,
} from './places-client';

const DEDUP_RADIUS_M = 50;
const NAME_SIM_THRESHOLD = 0.85;

// Phase 2 match-confirmation thresholds — deliberately looser than the
// pass-1 dedup so a slightly-drifted Google result still counts as
// confirmed. Tune off sample false-confirmations.
const MATCH_CONFIRM_MAX_DIST_M = 200;
const MATCH_CONFIRM_MIN_NAME_SIM = 0.7;

export interface DiscoveryPreviewResult {
  region: {
    regionId: string;
    name: string;
    state: string;
    bbox: { west: number; south: number; east: number; north: number };
  };
  totalOvertureCandidates: number;
  alreadyInCorpus: number;
  newCandidates: number;
  sample: Array<{
    name: string;
    address: string | null;
    lat: number;
    lng: number;
    overtureCategory: string | null;
    sourceId: string;
  }>;
  timings: {
    overtureSeconds: number;
    seededLoadSeconds: number;
    dedupSeconds: number;
    totalSeconds: number;
  };
}

interface SeededPoint {
  name: string;
  normalized: string;
  lat: number;
  lng: number;
}

export interface DiscoveryResolveSampleResult {
  region: {
    regionId: string;
    name: string;
    state: string;
  };
  totalOvertureCandidates: number;
  alreadyInCorpus: number;
  newCandidates: number;
  filteredEligibleCount: number;
  categoryDrops: {
    nullCategory: number;
    blockedCategory: number;
  };
  sample: Array<{
    overture: {
      name: string;
      address: string | null;
      lat: number;
      lng: number;
      category: string | null;
      sourceId: string;
    };
    resolved: {
      placeId: string;
      name: string;
      formattedAddress: string;
      lat: number;
      lng: number;
      matchConfirmed: boolean;
      matchReason: string;
    } | null;
    dedup: {
      existsInStaging: boolean;
      existsInProd: boolean;
      stagingIsSeeded: boolean | null;
      prodIsSeeded: boolean | null;
    } | null;
  }>;
  timings: {
    overtureSeconds: number;
    seededLoadSeconds: number;
    dedupSeconds: number;
    placesResolveSeconds: number;
    dedup2Seconds: number;
    totalSeconds: number;
  };
}

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    @InjectModel(DiscoveryRegion.name)
    private readonly regionModel: Model<DiscoveryRegionDocument>,
    private readonly configService: ConfigService,
  ) {}

  // Upsert the shipped region set into discoveryRegions. Idempotent —
  // safe to re-run; only fills gaps and refreshes bbox/priority. Never
  // resets `status` or `stats` (those are runtime state).
  async seedRegions(): Promise<{ upserted: number; total: number }> {
    let upserted = 0;
    for (const r of REGION_SEED_DATA) {
      const res = await this.regionModel.updateOne(
        { regionId: r.regionId },
        {
          $set: {
            name: r.name,
            state: r.state,
            bbox: r.bbox,
            priority: r.priority,
          },
          $setOnInsert: {
            regionId: r.regionId,
            status: 'pending',
            stats: {
              lastPreviewAt: null,
              totalOvertureCandidates: 0,
              alreadyInCorpus: 0,
              newCandidates: 0,
            },
          },
        },
        { upsert: true },
      );
      if (res.upsertedCount > 0) upserted++;
    }
    const total = await this.regionModel.countDocuments();
    return { upserted, total };
  }

  async previewRegion(regionId: string): Promise<DiscoveryPreviewResult> {
    const t0 = Date.now();
    const region = await this.regionModel.findOne({ regionId }).lean();
    if (!region) {
      throw new HttpException(`No region: ${regionId}`, 404);
    }
    const bbox = {
      west: region.bbox.west,
      south: region.bbox.south,
      east: region.bbox.east,
      north: region.bbox.north,
    };

    // Overture pull.
    const tOverture0 = Date.now();
    const candidates = await fetchOverturePlacesInBbox(bbox);
    const overtureSeconds = (Date.now() - tOverture0) / 1000;

    // Staging seeded businesses inside the same bbox.
    const tSeeded0 = Date.now();
    const seeded = await this.loadSeededInBbox(bbox);
    const seededLoadSeconds = (Date.now() - tSeeded0) / 1000;

    // Grid-index the seeded set for O(N) dedup instead of O(N*M).
    const tDedup0 = Date.now();
    const { alreadyInCorpus, newCandidates } = this.dedupPass1(
      candidates,
      seeded,
      (bbox.south + bbox.north) / 2,
    );
    const dedupSeconds = (Date.now() - tDedup0) / 1000;

    const sample = newCandidates.slice(0, 20).map((c) => ({
      name: c.name,
      address: c.address,
      lat: c.lat,
      lng: c.lng,
      overtureCategory: c.overtureCategory,
      sourceId: c.sourceId,
    }));

    // Persist stats on the region doc for visibility. Status stays PENDING
    // until Phase 2 apply — this is preview-only.
    await this.regionModel.updateOne(
      { regionId },
      {
        $set: {
          'stats.lastPreviewAt': new Date(),
          'stats.totalOvertureCandidates': candidates.length,
          'stats.alreadyInCorpus': alreadyInCorpus,
          'stats.newCandidates': newCandidates.length,
        },
      },
    );

    const totalSeconds = (Date.now() - t0) / 1000;
    this.logger.log(
      `[discovery.preview ${regionId}] overture=${candidates.length} ` +
        `seededInBbox=${seeded.length} alreadyInCorpus=${alreadyInCorpus} ` +
        `newCandidates=${newCandidates.length} (${totalSeconds.toFixed(1)}s)`,
    );

    return {
      region: {
        regionId: region.regionId,
        name: region.name,
        state: region.state,
        bbox,
      },
      totalOvertureCandidates: candidates.length,
      alreadyInCorpus,
      newCandidates: newCandidates.length,
      sample,
      timings: {
        overtureSeconds,
        seededLoadSeconds,
        dedupSeconds,
        totalSeconds,
      },
    };
  }

  // Phase 2: run the same preview pipeline, apply category filter, pick a
  // stride-sampled `limit` candidates, resolve each via Google Places
  // (searchText), then re-dedup the resolved placeIds against staging and
  // prod. No writes anywhere.
  async resolveSample(
    regionId: string,
    limit: number,
  ): Promise<DiscoveryResolveSampleResult> {
    const t0 = Date.now();
    const region = await this.regionModel.findOne({ regionId }).lean();
    if (!region) throw new HttpException(`No region: ${regionId}`, 404);
    const bbox = {
      west: region.bbox.west,
      south: region.bbox.south,
      east: region.bbox.east,
      north: region.bbox.north,
    };

    const tOverture0 = Date.now();
    const candidates = await fetchOverturePlacesInBbox(bbox);
    const overtureSeconds = (Date.now() - tOverture0) / 1000;

    const tSeeded0 = Date.now();
    const seeded = await this.loadSeededInBbox(bbox);
    const seededLoadSeconds = (Date.now() - tSeeded0) / 1000;

    const tDedup0 = Date.now();
    const { alreadyInCorpus, newCandidates } = this.dedupPass1(
      candidates,
      seeded,
      (bbox.south + bbox.north) / 2,
    );
    const dedupSeconds = (Date.now() - tDedup0) / 1000;

    // Category filter (blocklist + null-category drop). Count drops per
    // reason so the sample report can show what we filtered out and why.
    let nullDrops = 0;
    let blockedDrops = 0;
    const eligible: OvertureCandidate[] = [];
    for (const c of newCandidates) {
      if (!c.overtureCategory) {
        nullDrops++;
        continue;
      }
      if (isBlockedOvertureCategory(c.overtureCategory)) {
        blockedDrops++;
        continue;
      }
      eligible.push(c);
    }

    // Stride-pick `limit` items evenly across the eligible list. Overture's
    // natural row order is geohash-adjacent so stride sampling gives us
    // geographic spread without an explicit spatial partition. Reproducible
    // because eligible[] order is derived from the parquet, which is pinned
    // to OVERTURE_RELEASE.
    const picked = this.stridePick(eligible, limit);

    // Places API resolution — sequential, small volume (≤15). Parallelizing
    // this is easy but not worth the complexity at Phase 2 sample scale.
    const apiKey = this.configService.get<string>('app.googleApiKey') ?? '';
    if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not set');
    const tPlaces0 = Date.now();
    const resolved: Array<PlacesResolveResult | null> = [];
    for (const c of picked) {
      const r = await resolvePlaceIdBySearchText(
        {
          name: c.name,
          address: c.address,
          lat: c.lat,
          lng: c.lng,
          radiusMeters: 100,
        },
        apiKey,
      );
      resolved.push(r);
    }
    const placesResolveSeconds = (Date.now() - tPlaces0) / 1000;

    // Dedup pass 2 — batched $in query per environment.
    const tDedup20 = Date.now();
    const resolvedPlaceIds = resolved
      .map((r) => r?.placeId)
      .filter((x): x is string => !!x);
    const stagingHits = await this.checkPlaceIdExists(
      'pinntagStaging',
      resolvedPlaceIds,
    );
    const prodHits = await this.checkPlaceIdExists(
      'pinntagProd',
      resolvedPlaceIds,
    );
    const dedup2Seconds = (Date.now() - tDedup20) / 1000;

    // Build the sample report.
    const sample = picked.map((c, i) => {
      const r = resolved[i];
      const overture = {
        name: c.name,
        address: c.address,
        lat: c.lat,
        lng: c.lng,
        category: c.overtureCategory,
        sourceId: c.sourceId,
      };
      if (!r) {
        return { overture, resolved: null, dedup: null };
      }
      const dist = haversineMeters(c.lat, c.lng, r.lat, r.lng);
      const sim = nameSimilarity(normalizeName(c.name), normalizeName(r.name));
      const matchConfirmed =
        dist <= MATCH_CONFIRM_MAX_DIST_M && sim >= MATCH_CONFIRM_MIN_NAME_SIM;
      const matchReason = `name_sim=${sim.toFixed(2)} dist=${dist.toFixed(0)}m`;
      const stagingRec = stagingHits.get(r.placeId);
      const prodRec = prodHits.get(r.placeId);
      return {
        overture,
        resolved: {
          placeId: r.placeId,
          name: r.name,
          formattedAddress: r.formattedAddress,
          lat: r.lat,
          lng: r.lng,
          matchConfirmed,
          matchReason,
        },
        dedup: {
          existsInStaging: !!stagingRec,
          existsInProd: !!prodRec,
          stagingIsSeeded: stagingRec ? stagingRec.isSeeded : null,
          prodIsSeeded: prodRec ? prodRec.isSeeded : null,
        },
      };
    });

    const totalSeconds = (Date.now() - t0) / 1000;
    this.logger.log(
      `[discovery.resolveSample ${regionId}] overture=${candidates.length} ` +
        `seededInBbox=${seeded.length} newAfterPass1=${newCandidates.length} ` +
        `filteredEligible=${eligible.length} picked=${picked.length} ` +
        `resolved=${resolved.filter((r) => r).length} ` +
        `(${totalSeconds.toFixed(1)}s)`,
    );

    return {
      region: {
        regionId: region.regionId,
        name: region.name,
        state: region.state,
      },
      totalOvertureCandidates: candidates.length,
      alreadyInCorpus,
      newCandidates: newCandidates.length,
      filteredEligibleCount: eligible.length,
      categoryDrops: {
        nullCategory: nullDrops,
        blockedCategory: blockedDrops,
      },
      sample,
      timings: {
        overtureSeconds,
        seededLoadSeconds,
        dedupSeconds,
        placesResolveSeconds,
        dedup2Seconds,
        totalSeconds,
      },
    };
  }

  private stridePick<T>(arr: T[], limit: number): T[] {
    if (arr.length <= limit) return arr.slice();
    const stride = arr.length / limit;
    const out: T[] = [];
    for (let i = 0; i < limit; i++) {
      out.push(arr[Math.floor(i * stride)]);
    }
    return out;
  }

  // Batched placeId lookup against one environment. Returns a map from
  // placeId to { isSeeded } for every match found. Uses buildSeededFilter
  // only to tag the isSeeded flag — the existence check itself considers
  // organic businesses too so we don't create a duplicate seeded entry
  // for a placeId that already lives as an organic doc.
  private async checkPlaceIdExists(
    envKey: 'pinntagStaging' | 'pinntagProd',
    placeIds: string[],
  ): Promise<Map<string, { isSeeded: boolean }>> {
    const out = new Map<string, { isSeeded: boolean }>();
    if (!placeIds.length) return out;
    const uri = this.configService.get<string>(`database.${envKey}`);
    if (!uri) {
      this.logger.warn(`No URI configured for ${envKey} — skipping dedup2`);
      return out;
    }
    const conn = await mongoose.createConnection(uri).asPromise();
    try {
      const BusinessModel = conn.model(
        'DiscBiz',
        new mongoose.Schema({}, { strict: false }),
        'businesses',
      );
      const docs = (await BusinessModel.find(
        { placeId: { $in: placeIds }, isDeleted: { $ne: true } },
        {
          placeId: 1,
          isCvb: 1,
          isFromCrawler: 1,
          'seedProvenance.isSeeded': 1,
        },
      ).lean()) as any[];
      for (const d of docs) {
        const isSeeded = !!(
          d.isCvb ||
          d.isFromCrawler ||
          d.seedProvenance?.isSeeded
        );
        out.set(String(d.placeId), { isSeeded });
      }
    } finally {
      await conn.close();
    }
    return out;
  }

  private async loadSeededInBbox(bbox: {
    west: number;
    south: number;
    east: number;
    north: number;
  }): Promise<SeededPoint[]> {
    const stagingUri = this.configService.get<string>(
      'database.pinntagStaging',
    );
    if (!stagingUri) {
      throw new Error('No URI configured for pinntagStaging');
    }
    const conn = await mongoose.createConnection(stagingUri).asPromise();
    try {
      const BusinessModel = conn.model(
        'DiscBiz',
        new mongoose.Schema({}, { strict: false }),
        'businesses',
      );
      // buildSeededFilter — never the bare `isCvb OR isFromCrawler` legacy
      // pair. Also restrict to docs with numeric lat/lng inside the bbox.
      const query: Record<string, any> = {
        $and: [
          buildSeededFilter(),
          { latitude: { $gte: bbox.south, $lte: bbox.north } },
          { longitude: { $gte: bbox.west, $lte: bbox.east } },
          { isDeleted: { $ne: true } },
        ],
      };
      const docs = (await BusinessModel.find(query, {
        name: 1,
        latitude: 1,
        longitude: 1,
      }).lean()) as any[];

      return docs
        .filter(
          (d) =>
            typeof d.latitude === 'number' &&
            typeof d.longitude === 'number' &&
            d.name,
        )
        .map((d) => ({
          name: String(d.name),
          normalized: normalizeName(String(d.name)),
          lat: d.latitude,
          lng: d.longitude,
        }));
    } finally {
      await conn.close();
    }
  }

  private dedupPass1(
    candidates: OvertureCandidate[],
    seeded: SeededPoint[],
    centerLat: number,
  ): { alreadyInCorpus: number; newCandidates: OvertureCandidate[] } {
    // Bucket size = DEDUP_RADIUS_M. Any point within radius of a candidate
    // is guaranteed to sit in one of the candidate's 3x3 neighboring
    // buckets, so we haversine-check only those.
    const latStep = metersToLatDeg(DEDUP_RADIUS_M);
    const lngStep = metersToLngDeg(DEDUP_RADIUS_M, centerLat);

    const grid = new Map<string, SeededPoint[]>();
    const keyOf = (lat: number, lng: number): string => {
      const li = Math.floor(lat / latStep);
      const lj = Math.floor(lng / lngStep);
      return `${li}:${lj}`;
    };
    for (const s of seeded) {
      const k = keyOf(s.lat, s.lng);
      const bucket = grid.get(k);
      if (bucket) bucket.push(s);
      else grid.set(k, [s]);
    }

    let alreadyInCorpus = 0;
    const newCandidates: OvertureCandidate[] = [];
    for (const c of candidates) {
      const li = Math.floor(c.lat / latStep);
      const lj = Math.floor(c.lng / lngStep);
      const cNorm = normalizeName(c.name);
      let matched = false;
      outer: for (let di = -1; di <= 1 && !matched; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const bucket = grid.get(`${li + di}:${lj + dj}`);
          if (!bucket) continue;
          for (const s of bucket) {
            const dist = haversineMeters(c.lat, c.lng, s.lat, s.lng);
            if (dist > DEDUP_RADIUS_M) continue;
            const sim = nameSimilarity(cNorm, s.normalized);
            if (sim >= NAME_SIM_THRESHOLD) {
              matched = true;
              break outer;
            }
          }
        }
      }
      if (matched) alreadyInCorpus++;
      else newCandidates.push(c);
    }
    return { alreadyInCorpus, newCandidates };
  }
}
