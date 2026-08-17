import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum BotJobStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  DONE = 'done',
  FAILED = 'failed',
}

export enum BotJobType {
  GALLERY_MENU = 'gallery_menu',
  REVIEWS = 'reviews',
  IMAGE_SYNC = 'image_sync',
  COVER_SYNC = 'cover_sync',
  RESOLVE_BUSINESS = 'resolve_business',
  // Visits the business's own website and extracts a literally-present
  // email address. No inference, no third-party enrichment. Backs the
  // c10_verified_email gate criterion.
  EMAIL_SCRAPE = 'email_scrape',
  // Discovery Phase 4 resolver. Given an Overture candidate (name,
  // address, coords) and the region bbox, the bot searches Google Maps
  // for the matching business — reuses the resolve_business geo-anchor
  // and state-mismatch guards — and returns {placeId, name,
  // formattedAddress, lat, lng}. Replaces the Places API call so the
  // whole discovery path is bot-only. No Business doc exists yet, so
  // the result is written back to the job doc itself (discoveryResult
  // field), not to a Business.
  DISCOVERY_SEARCH = 'discovery_search',
}

@Schema({ timestamps: true, collection: 'dopBotJobs' })
export class BotJob {
  // Optional for resolve_business — those jobs may run from address alone
  // when no valid ChIJ placeId is on record yet. Required in practice for
  // every other job type; the bot guards on this.
  @Prop({ required: false, default: '' })
  placeId: string;

  @Prop({ required: true })
  businessId: string;

  @Prop({ required: true })
  businessName: string;

  @Prop({ required: true })
  environment: string;

  @Prop({ required: false, default: '' })
  sessionId: string;

  @Prop({ type: String, enum: BotJobType, required: true })
  type: BotJobType;

  @Prop({ type: String, enum: BotJobStatus, default: BotJobStatus.PENDING })
  status: BotJobStatus;

  @Prop({ type: Number, default: 100 })
  maxReviews: number;

  // Address payload carried for resolve_business — Google Maps search
  // URL is built from these when placeId is missing/invalid.
  @Prop({ type: String, default: '' })
  addressLine1: string;

  // Legacy field — kept so the bot can fall back to it inside
  // _sanitize_query_fields when addressLine1 is empty but address1
  // still has the street portion. Read-only from the bot's POV.
  @Prop({ type: String, default: '' })
  address1: string;

  @Prop({ type: String, default: '' })
  city: string;

  @Prop({ type: String, default: '' })
  state: string;

  @Prop({ type: String, default: '' })
  postalCode: string;

  // Coordinates — carried so the bot's coord-contradiction check
  // (drop stored city/state when they don't sit inside the coords'
  // country) can run without a DB round-trip.
  @Prop({ type: Number, default: null })
  latitude?: number | null;

  @Prop({ type: Number, default: null })
  longitude?: number | null;

  // Website URL carried for email_scrape — the bot fetches this page
  // (plus a few contact/about links) to extract a literally-present email.
  @Prop({ type: String, default: '' })
  website: string;

  @Prop({ type: Date, default: null })
  claimedAt?: Date;

  @Prop({ type: Date, default: null })
  completedAt?: Date;

  @Prop({ type: String, default: null })
  error?: string;

  @Prop({ type: Number, default: 0 })
  attempts!: number;

  // ── Discovery Phase 4 fields (only set on DISCOVERY_SEARCH jobs) ──
  // The discovery pipeline has no Business doc at enqueue time — the
  // Business is created after judgment. So the job doc itself carries
  // both the input (region context + overture candidate) and the
  // output (bot-resolved match), and the orchestrator polls
  // dopBotJobs for terminal jobs on its runId to drive downstream
  // (dedup2 → judge → insert).
  @Prop({ type: String, default: '' })
  discoveryRunId?: string;

  @Prop({ type: String, default: '' })
  discoveryRegionId?: string;

  @Prop({ type: String, default: '' })
  discoveryOvertureSourceId?: string;

  // Region bbox — bot uses (a) the centroid as the @lat,lng viewport
  // anchor when the candidate lacks coords, and (b) as a hard
  // reject: if the resolved place lands outside this rectangle we
  // return null rather than accept a cross-region match.
  @Prop({ type: Number, default: null })
  discoveryBboxWest?: number | null;
  @Prop({ type: Number, default: null })
  discoveryBboxSouth?: number | null;
  @Prop({ type: Number, default: null })
  discoveryBboxEast?: number | null;
  @Prop({ type: Number, default: null })
  discoveryBboxNorth?: number | null;

  // Bot-written result — mirrors PlacesResolveResult shape so the
  // downstream judgment/insert path stays byte-identical to the old
  // Places-API-based resolver.
  @Prop({ type: Object, default: null })
  discoveryResult?: {
    placeId: string;
    name: string;
    formattedAddress: string;
    lat: number;
    lng: number;
  } | null;

  // Diagnostic: why the bot returned no match (state_mismatch, bbox
  // reject, no_search_match, …). Non-null even when discoveryResult
  // is also null — the orchestrator maps this to a zero_result
  // outcome without a downstream judge/insert.
  @Prop({ type: String, default: '' })
  discoveryError?: string;

  // Set by DiscoveryRunService.consumeBotResults once the bot's result
  // has been driven through the downstream pipeline (judge → insert →
  // discoveryProcessed) or logged as zero_result. Prevents a re-run
  // of the consumer from re-judging + double-inserting the same
  // sourceId. Only meaningful on DISCOVERY_SEARCH jobs.
  @Prop({ type: Boolean, default: false })
  consumed?: boolean;

  @Prop({ type: Date, default: null })
  consumedAt?: Date | null;

  // Populated when the consumer produced an accept/review insert.
  // Null for zero_result / skip / not_applicable / duplicate-of-earlier-run.
  @Prop({ type: String, default: null })
  consumedBusinessId?: string | null;
}

export type BotJobDocument = BotJob & Document;
export const BotJobSchema = SchemaFactory.createForClass(BotJob);

BotJobSchema.index({ status: 1, createdAt: 1 });
BotJobSchema.index({ sessionId: 1 });
// Consumer sweep — pull done+unconsumed DISCOVERY_SEARCH jobs by runId.
BotJobSchema.index({ type: 1, discoveryRunId: 1, status: 1, consumed: 1 });
