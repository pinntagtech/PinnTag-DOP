import { HttpException, Injectable, Logger } from '@nestjs/common';
import mongoose from 'mongoose';
import { GateService } from './gate.service';
import { SeedingEnvironments } from '../../../common/constants';

// Recompute Business.seedProvenance across the seeded corpus.
//
// The historical cohort definition (`isCvb OR isFromCrawler`) silently
// excluded businesses created by the internal data-seeding team via the
// target PinnTag app itself — those docs carry `creatorType='BusinessUser'`
// and never picked up either legacy flag. This service materializes the
// full cohort as `Business.seedProvenance` so filters, gate passes, and
// dedup can select the union with a single indexed predicate.
//
// Provenance sources (all three carry equal weight and can coexist on one
// doc — the field is a `sources[]` array):
//   crawler         → the doc has isFromCrawler:true
//   cvb             → the doc has isCvb:true
//   manual_seeder   → the doc is linked to a BusinessUser whose email
//                     matches /surbhi|vipin/i (the internal seeders' pool)
//
// Manual-seeder link detection (in priority order, first hit wins):
//   1. BusinessUser.business[] back-ref  — 100% coverage on the staging
//      union; survives even when authorisedUser was reassigned later.
//   2. Business.authorisedUser           — 96% coverage; fallback for the
//      rare docs missing from any back-ref array.
//   3. Business.creator                  — final fallback, same shape.
//
// Widening only: a doc that currently carries isCvb or isFromCrawler is
// never marked isSeeded:false by this job, even if no manual-seeder link
// is found. New sources are additive.

const RECOMPUTE_BATCH_SIZE = 500;
const SEEDER_EMAIL_RE = /surbhi|vipin/i;

export interface ProvenanceRecomputeRequest {
  environment: string;
  dryRun?: boolean;
}

export interface ProvenanceRecomputeResult {
  environment: string;
  dryRun: boolean;
  seederCount: number;
  seederEmails: string[];
  scanned: number;
  updated: number;
  totals: {
    isSeededAfter: number;
    // Business counts by source membership (a doc can be counted twice
    // if it carries multiple sources — e.g. crawler AND manual_seeder).
    bySource: Record<string, number>;
    // How many previously-legacy docs picked up the manual_seeder source
    // in addition to their existing crawler/cvb source (overlap).
    manualOverlapWithLegacy: number;
    // Docs that would flip from isSeeded:false (or undefined) to true.
    netNewIsSeeded: number;
  };
  durationMs: number;
  computedAt: string;
}

interface SeederIndex {
  seederIds: mongoose.Types.ObjectId[];
  // BusinessId → seederEmail. Built from the seeders' `business[]`
  // back-ref arrays. Direct-link fallbacks (authorisedUser/creator) also
  // populate this so every manual-seeder doc lands with the right email.
  emailByBusinessId: Map<string, string>;
  emailById: Map<string, string>;
}

@Injectable()
export class ProvenanceService {
  private readonly logger = new Logger(ProvenanceService.name);

  constructor(private readonly gateService: GateService) {}

  async recompute(
    req: ProvenanceRecomputeRequest,
  ): Promise<ProvenanceRecomputeResult> {
    // Locked to staging. Prod / pre-prod flow through /gated-migration.
    if (req.environment !== SeedingEnvironments.STAGING) {
      throw new HttpException(
        `provenance recompute is staging-only (got ${req.environment})`,
        400,
      );
    }
    const dryRun = req.dryRun !== false; // default true
    const start = Date.now();

    const conn = await this.gateService.openConnection(req.environment);
    try {
      const businesses = conn.collection('businesses');
      const businessUsers = conn.collection('businessusers');

      // ── Resolve seeder ids ONCE ──────────────────────────────────────
      const seederIndex = await this.buildSeederIndex(businessUsers);
      this.logger.log(
        `[PROVENANCE] env=${req.environment} seeders=${seederIndex.seederIds.length} ` +
          `backrefBiz=${seederIndex.emailByBusinessId.size}`,
      );

      // ── Cursor over the union of (legacy cohort ∪ seeder-linked) ─────
      // We scan the union so we can (a) add manual_seeder to legacy docs
      // if the seeder also owns them, (b) tag net-new manual-only docs,
      // and (c) leave the isSeeded flag set on legacy docs even when no
      // seeder link is found (widening only).
      const seederIds = seederIndex.seederIds;
      const scanFilter: Record<string, any> = {
        $or: [
          { isCvb: true },
          { isFromCrawler: true },
          { _id: { $in: Array.from(seederIndex.emailByBusinessId.keys()).map(id => new mongoose.Types.ObjectId(id)) } },
          { authorisedUser: { $in: seederIds } },
          { creator: { $in: seederIds } },
        ],
      };

      const projection = {
        _id: 1,
        isCvb: 1,
        isFromCrawler: 1,
        authorisedUser: 1,
        creator: 1,
        seedProvenance: 1,
      } as const;

      const cursor = businesses.find(scanFilter, { projection });
      const computedAt = new Date();
      let scanned = 0;
      let updated = 0;
      const bySource: Record<string, number> = {
        crawler: 0,
        cvb: 0,
        manual_seeder: 0,
      };
      let isSeededAfter = 0;
      let manualOverlapWithLegacy = 0;
      let netNewIsSeeded = 0;

      let batch: mongoose.mongo.AnyBulkWriteOperation[] = [];
      const flush = async () => {
        if (!batch.length) return;
        if (!dryRun) {
          const res = await businesses.bulkWrite(batch, { ordered: false });
          updated += res.modifiedCount ?? 0;
        }
        batch = [];
      };

      for await (const doc of cursor) {
        scanned++;
        const sources: string[] = [];
        if (doc.isFromCrawler === true) sources.push('crawler');
        if (doc.isCvb === true) sources.push('cvb');

        const email = this.resolveSeederEmail(doc, seederIndex);
        if (email) sources.push('manual_seeder');

        // Widening only: if we somehow scanned a doc with no sources and
        // no legacy flag, don't write anything (would be a no-op anyway).
        if (!sources.length) continue;

        for (const s of sources) bySource[s]++;
        isSeededAfter++;

        const hadLegacy = doc.isFromCrawler === true || doc.isCvb === true;
        const isManual = sources.includes('manual_seeder');
        if (hadLegacy && isManual) manualOverlapWithLegacy++;

        const priorIsSeeded = doc.seedProvenance?.isSeeded === true;
        if (!priorIsSeeded) netNewIsSeeded++;

        batch.push({
          updateOne: {
            filter: { _id: doc._id as unknown as mongoose.Types.ObjectId },
            update: {
              $set: {
                seedProvenance: {
                  isSeeded: true,
                  sources,
                  seederEmail: email ?? null,
                  computedAt,
                },
              },
            },
          },
        });
        if (batch.length >= RECOMPUTE_BATCH_SIZE) await flush();
      }
      await flush();

      const durationMs = Date.now() - start;
      this.logger.log(
        `[PROVENANCE] env=${req.environment} dryRun=${dryRun} scanned=${scanned} ` +
          `updated=${updated} isSeededAfter=${isSeededAfter} ` +
          `bySource=${JSON.stringify(bySource)} ` +
          `manualOverlap=${manualOverlapWithLegacy} netNew=${netNewIsSeeded} ` +
          `durationMs=${durationMs}`,
      );

      return {
        environment: req.environment,
        dryRun,
        seederCount: seederIndex.seederIds.length,
        seederEmails: Array.from(new Set(seederIndex.emailById.values())).sort(),
        scanned,
        updated,
        totals: {
          isSeededAfter,
          bySource,
          manualOverlapWithLegacy,
          netNewIsSeeded,
        },
        durationMs,
        computedAt: computedAt.toISOString(),
      };
    } finally {
      await conn.close();
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async buildSeederIndex(
    businessUsers: mongoose.mongo.Collection,
  ): Promise<SeederIndex> {
    const seeders = await businessUsers
      .find(
        { $or: [{ email: SEEDER_EMAIL_RE }, { name: SEEDER_EMAIL_RE }] },
        { projection: { _id: 1, email: 1, business: 1 } },
      )
      .toArray();

    const seederIds: mongoose.Types.ObjectId[] = [];
    const emailById = new Map<string, string>();
    const emailByBusinessId = new Map<string, string>();

    for (const s of seeders) {
      const sid = s._id as mongoose.Types.ObjectId;
      seederIds.push(sid);
      const email = typeof s.email === 'string' ? s.email : '';
      emailById.set(String(sid), email);
      if (Array.isArray(s.business)) {
        for (const bid of s.business) {
          if (!bid) continue;
          const key = String(bid);
          // Never overwrite an already-set business → keeps the first
          // seeder we see as the owning email, even if a second seeder
          // also carries the id in their back-ref (rare).
          if (!emailByBusinessId.has(key)) emailByBusinessId.set(key, email);
        }
      }
    }
    return { seederIds, emailByBusinessId, emailById };
  }

  private resolveSeederEmail(
    doc: Record<string, any>,
    idx: SeederIndex,
  ): string | null {
    // 1. Back-ref (highest coverage on staging: 100% of the union)
    const backrefEmail = idx.emailByBusinessId.get(String(doc._id));
    if (backrefEmail) return backrefEmail;
    // 2. authorisedUser
    const auth = doc.authorisedUser ? String(doc.authorisedUser) : '';
    if (auth && idx.emailById.has(auth)) return idx.emailById.get(auth) ?? null;
    // 3. creator
    const creator = doc.creator ? String(doc.creator) : '';
    if (creator && idx.emailById.has(creator))
      return idx.emailById.get(creator) ?? null;
    return null;
  }
}
