// Builds and inserts a Phase 4 discovery-sourced draft business into
// staging. Shape matches the Phase 3 Report 2 proposal — status 4.1,
// isActive false, isFromCrawler true, no outlet (per CLAUDE.md
// "outlets are distinct physical locations, NEVER copy parent"),
// seedProvenance.source='discovery', llmJudgment blob attached.
//
// Uses a per-call staging mongoose connection (opened, one write,
// closed) to match the CvbService pattern already in use — keeps
// connection lifetimes short and avoids pinning a long-lived
// staging connection to the API process.

import mongoose, { Types } from 'mongoose';
import { RecordJudgment } from '../judgment/types';
import { OvertureCandidate } from './overture-client';
import { PlacesResolveResult } from './places-client';

export interface InsertContext {
  stagingUri: string;
  regionId: string;
  runId: string;
}

export interface InsertInput {
  overture: OvertureCandidate;
  resolved: PlacesResolveResult; // non-null — accept & review both require it
  judgment: RecordJudgment;
  needsReview: boolean;
}

const LOOSE = new mongoose.Schema({}, { strict: false });

// Opens a fresh staging connection scoped to a single insert. Callers
// can wrap many inserts by opening/closing themselves via
// openStagingConnection + insertBusinessOn(conn, ...).
export async function openStagingConnection(
  stagingUri: string,
): Promise<mongoose.Connection> {
  return await mongoose.createConnection(stagingUri).asPromise();
}

export async function insertBusinessOn(
  conn: mongoose.Connection,
  ctx: Pick<InsertContext, 'regionId' | 'runId'>,
  input: InsertInput,
): Promise<string> {
  const BusinessModel =
    conn.models['Business'] || conn.model('Business', LOOSE, 'businesses');

  const cat = input.judgment.category.decision;
  const city = input.judgment.city.decision;

  const doc: any = {
    // Core identity — Google is authoritative once we accept.
    placeId: input.resolved.placeId,
    name: input.resolved.name,
    // addressLine1 is the consumer display field per CLAUDE.md; address1
    // is the legacy field the scraper-adapter still writes, so we
    // populate both to keep downstream readers happy without a schema
    // migration.
    addressLine1: input.resolved.formattedAddress,
    address1: input.resolved.formattedAddress,
    city: city.city ?? '',
    state: city.state ?? '',
    latitude: input.resolved.lat,
    longitude: input.resolved.lng,
    countryCode: '+1',

    // Taxonomy — real ObjectIds when the judgment mapped, empty when
    // it couldn't (review case).
    businessIndustry: cat.industryId
      ? new Types.ObjectId(cat.industryId)
      : undefined,
    businessCategories: (cat.categoryIds ?? []).map(
      (id) => new Types.ObjectId(id),
    ),

    // Draft-state markers — same as the scraper-adapter path so the
    // visibility gate (isActive AND >=1 active outlet) keeps this
    // invisible to consumer readers. No outlet created — that's a
    // deliberate manual downstream step.
    status: 4.1,
    continueJourney: false,
    isActive: false,
    isFromCrawler: true,

    // Provenance — lets us re-run idempotently, cohort-scope by region,
    // and back-out an entire run without touching organic docs.
    seedProvenance: {
      isSeeded: true,
      source: 'discovery',
      regionId: ctx.regionId,
      runId: ctx.runId,
      overtureSourceId: input.overture.sourceId,
      overtureCategory: input.overture.overtureCategory,
      discoveryRunAt: new Date(),
    },

    // Full audit trail. The consumer app doesn't read this; portal
    // review queue does.
    llmJudgment: input.judgment,
    needsReview: input.needsReview,
    needsReviewByJudge: input.judgment.needsReviewByJudge,
  };

  const inserted = await BusinessModel.create(doc);
  return String((inserted as any)._id);
}
