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

const DEDUP_RADIUS_M = 50;
const NAME_SIM_THRESHOLD = 0.85;

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
