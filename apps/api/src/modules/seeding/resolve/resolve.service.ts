import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import {
  EnvironmentUriKey,
  SeedingErrorMessages,
} from '../../../common/constants';
import { BotJobService } from '../bot/bot-job.service';
import { BotJobType } from '../schemas/bot-job.schema';
import { defaultRegularTiming } from '../data-repair/data-repair.constants';
import { parseHoursRaw } from './hours-parser';
import {
  canonicalCategoryIds,
  lookupGoogleCategory,
} from './google-category-map';
import { CoverB2SyncService } from './cover-b2-sync.service';
import { FixBatchService } from './fix-batch.service';
import {
  compareNames,
  isValidChIJPlaceId,
  normalizeName,
} from './name-match';

const LOOSE_SCHEMA = new mongoose.Schema<any>(
  {},
  { strict: false, timestamps: true },
);

// Junk-name filter for the candidates list: we only want authentic
// businesses to go through Google. Anything matching test/dummy patterns
// is excluded so an operator can't accidentally burn quota on garbage.
const JUNK_NAME_RE = /(?:test|testing|dummy|sample|asdf|xyzzy)/i;

// Comparing a stored regularTiming to the data-repair default tells the
// portal whether the business is still on the placeholder schedule.
//
// Two signatures matter:
//   NEW — defaultRegularTiming() in the schema-correct shape with
//         weekDays nesting + isClosed flags.
//   OLD — the legacy flat shape (no weekDays nesting, zero-duration
//         object for Sat/Sun) that ~8,609 placeholder businesses were
//         written under. Those rows haven't been migrated yet; the
//         placeholder badge needs to keep showing for them so an
//         operator can still find them in the resolve queue.
const PLACEHOLDER_SIGNATURE_NEW = JSON.stringify(defaultRegularTiming());
const PLACEHOLDER_SIGNATURE_OLD = JSON.stringify({
  sunday:    { duration: { startHour: 0, startMinute: 0, endHour: 0,  endMinute: 0 } },
  monday:    { duration: { startHour: 9, startMinute: 0, endHour: 17, endMinute: 0 } },
  tuesday:   { duration: { startHour: 9, startMinute: 0, endHour: 17, endMinute: 0 } },
  wednesday: { duration: { startHour: 9, startMinute: 0, endHour: 17, endMinute: 0 } },
  thursday:  { duration: { startHour: 9, startMinute: 0, endHour: 17, endMinute: 0 } },
  friday:    { duration: { startHour: 9, startMinute: 0, endHour: 17, endMinute: 0 } },
  saturday:  { duration: { startHour: 0, startMinute: 0, endHour: 0,  endMinute: 0 } },
});

function isPlaceholderRegularTiming(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  try {
    const s = JSON.stringify(value);
    return s === PLACEHOLDER_SIGNATURE_NEW || s === PLACEHOLDER_SIGNATURE_OLD;
  } catch {
    return false;
  }
}

export interface ResolveCandidateRow {
  _id: string;
  name?: string;
  addressLine1?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  placeId?: string | null;
  regularTimingIsPlaceholder: boolean;
  hasRegularTiming: boolean;
  resolveStatus?: any;
}

export interface ResolveReviewRow {
  _id: string;
  name?: string;
  city?: string;
  state?: string;
  placeId?: string | null;
  resolveStatus: {
    status: 'review';
    reason?: string;
    resolvedName?: string;
    resolvedPlaceId?: string | null;
    hoursRaw?: string[];
    checkedAt?: Date;
  };
}

export interface ResolveCandidatesFilters {
  environment: string;
  page?: number;
  limit?: number;
  search?: string;
  city?: string;
  state?: string;
}

export interface ResolveWebhookPayload {
  businessId: string;
  environment: string;
  sessionId?: string;
  resolvedPlaceId?: string | null;
  resolvedName?: string | null;
  hoursRaw?: string[];
  // Soft note from the bot when the only ChIJ visible on the resolved
  // page is the stored building id (i.e. no real upgrade is available).
  // The bot returns resolvedPlaceId: null in this case AND sets this
  // note; the webhook treats it as a non-blocking placeId-side review
  // signal, never as a poison-pill error.
  placeIdNote?: 'equals_building' | string;
  // Extra cheap reads off the same panel. Each is independently
  // decoupled from hours/placeId — a missing/null field never blocks
  // the other writes.
  rating?: number | null;
  userRatingCount?: number | null;
  // RAW Google googleusercontent URL. Webhook stores it as
  // pendingCoverUrl when no cover exists yet; the actual
  // download-and-upload-to-B2 happens in CoverB2SyncService, not here.
  coverUrl?: string | null;
  // Raw Google Maps category line (e.g. "Nail salon"). The webhook
  // stores it on the business + computes a categoryStatus by mapping
  // it against GOOGLE_CATEGORY_MAP — but never overwrites the live
  // businessIndustry / businessCategories. Auto-apply is off-by-design
  // until the operator validates mappings via the data-repair tab.
  googleCategory?: string | null;
  // Raw single-line address as Google rendered it on the business
  // panel (e.g. "927 Fulton St, Brooklyn, NY 11238, United States" or
  // "Sector 41, E Block, Sector 50, Noida, Uttar Pradesh 201303").
  // Stored authentically; component parse + proposedAddress flagging
  // happens server-side (libpostal — currently unavailable on the
  // API box, so we mark addressStatus='address_unparsed' as a
  // fallback). NEVER auto-applied to address1/city/state/postalCode.
  googleFormattedAddress?: string | null;
  error?: string;
}

@Injectable()
export class ResolveService {
  private readonly logger = new Logger(ResolveService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly botJobService: BotJobService,
    // Used to run step 3 of the one-click "Fix" cascade (cover B2
    // upload) inline immediately after step 1 (resolve) writes
    // pendingCoverUrl. Reuses the same per-business code path the
    // batch sync uses — no second implementation.
    private readonly coverB2SyncService: CoverB2SyncService,
    // Per-batch attribution + email summary on completion. Decoupled
    // from the fix pipeline — every call site uses try/catch so a
    // batch tracking failure can't poison the resolve outcome.
    private readonly fixBatchService: FixBatchService,
  ) {}

  // ────────────────────────────────────────────────────────────
  // PUBLIC: list candidates (authentic businesses worth resolving)
  // ────────────────────────────────────────────────────────────

  async listCandidates(filters: ResolveCandidatesFilters): Promise<{
    businesses: ResolveCandidateRow[];
    total: number;
    page: number;
    pages: number;
  }> {
    const { environment } = filters;
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 25, 100);

    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);

      const query: Record<string, any> = {
        $and: [
          { $or: [{ isCvb: true }, { isFromCrawler: true }] },
          { isDeleted: { $ne: true } },
          { addressLine1: { $nin: [null, ''] } },
          { city: { $nin: [null, ''] } },
          { state: { $nin: [null, ''] } },
          // Real-looking name: length ≥ 3 and not matching obvious junk.
          {
            name: {
              $exists: true,
              $type: 'string',
              $not: JUNK_NAME_RE,
            },
          },
          { $expr: { $gte: [{ $strLenCP: { $ifNull: ['$name', ''] } }, 3] } },
        ],
      };

      if (filters.city) {
        query.$and!.push({
          city: new RegExp(escapeRegex(filters.city), 'i'),
        });
      }
      if (filters.state) {
        query.$and!.push({
          state: new RegExp(escapeRegex(filters.state), 'i'),
        });
      }
      if (filters.search) {
        query.$and!.push({
          $or: [
            { name: new RegExp(escapeRegex(filters.search), 'i') },
            { addressLine1: new RegExp(escapeRegex(filters.search), 'i') },
          ],
        });
      }

      const total = await Business.countDocuments(query);
      const pages = Math.max(1, Math.ceil(total / limit));

      const docs = await Business.find(query)
        .select(
          '_id name addressLine1 address1 city state postalCode ' +
            'placeId regularTiming resolveStatus',
        )
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      const businesses: ResolveCandidateRow[] = (docs as any[]).map((d) => ({
        _id: String(d._id),
        name: d.name,
        addressLine1: d.addressLine1,
        address1: d.address1,
        city: d.city,
        state: d.state,
        postalCode: d.postalCode,
        placeId: d.placeId ?? null,
        regularTimingIsPlaceholder: isPlaceholderRegularTiming(d.regularTiming),
        hasRegularTiming:
          d.regularTiming != null && typeof d.regularTiming === 'object',
        resolveStatus: d.resolveStatus,
      }));

      return { businesses, total, page, pages };
    } finally {
      await conn.close();
    }
  }

  // ────────────────────────────────────────────────────────────
  // PUBLIC: list flagged-for-review
  // ────────────────────────────────────────────────────────────

  async listForReview(
    environment: string,
    page = 1,
    limit = 25,
  ): Promise<{
    businesses: ResolveReviewRow[];
    total: number;
    page: number;
    pages: number;
  }> {
    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);
      const query = {
        'resolveStatus.status': 'review',
        isDeleted: { $ne: true },
      };

      const total = await Business.countDocuments(query);
      const pages = Math.max(1, Math.ceil(total / limit));

      const docs = await Business.find(query)
        .select('_id name city state placeId resolveStatus')
        .sort({ 'resolveStatus.checkedAt': -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      const businesses: ResolveReviewRow[] = (docs as any[]).map((d) => ({
        _id: String(d._id),
        name: d.name,
        city: d.city,
        state: d.state,
        placeId: d.placeId ?? null,
        resolveStatus: d.resolveStatus,
      }));

      return { businesses, total, page, pages };
    } finally {
      await conn.close();
    }
  }

  // ────────────────────────────────────────────────────────────
  // PUBLIC: enqueue resolve_business jobs for selected businesses
  // ────────────────────────────────────────────────────────────

  async triggerResolve(args: {
    environment: string;
    businessIds: string[];
    force?: boolean;
    // Optional label carried onto the dopFixBatches doc so the summary
    // email subject can say "DOP Fix complete — <city> — N/M fixed".
    // Free-form; pass through from the operator's candidate filter.
    city?: string;
  }): Promise<{
    created: number;
    skippedAlreadyDone: number;
    batchId?: string;
  }> {
    const { environment, businessIds, force } = args;
    if (!Array.isArray(businessIds) || businessIds.length === 0) {
      return { created: 0, skippedAlreadyDone: 0 };
    }

    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);
      const docs = await Business.find({
        _id: {
          $in: businessIds.map((id) => new mongoose.Types.ObjectId(id)),
        },
        isDeleted: { $ne: true },
      })
        .select(
          '_id name addressLine1 address1 city state postalCode placeId ' +
            'resolveStatus categoryStatus pendingCoverUrl',
        )
        .lean();

      // Skip "fully fixed" for cheap resumability under the one-click
      // cascade. A business is fully fixed when:
      //   resolveStatus.status === 'done'  (hours landed)
      //   AND categoryStatus !== 'mismatch' (taxonomy is correct,
      //                                      unmapped, or no_google_cat
      //                                      — nothing left to do here)
      //   AND no pendingCoverUrl           (B2 cover sync finished or
      //                                      was never staged)
      // Anything else gets re-enqueued so the cascade can finish the
      // missing step on this visit. `force:true` bypasses the skip.
      let skippedAlreadyDone = 0;
      const filtered = (docs as any[]).filter((b) => {
        if (force) return true;
        const status = b?.resolveStatus?.status;
        const categoryStatus = b?.categoryStatus;
        const hasPendingCover =
          typeof b?.pendingCoverUrl === 'string' &&
          b.pendingCoverUrl.length > 0;
        const fullyFixed =
          status === 'done' &&
          categoryStatus !== 'mismatch' &&
          !hasPendingCover;
        if (fullyFixed) {
          skippedAlreadyDone += 1;
          return false;
        }
        return true;
      });

      const records = filtered.map((b) => ({
        placeId: b.placeId || '',
        businessId: String(b._id),
        businessName: b.name || '',
        environment,
        addressLine1: b.addressLine1 || b.address1 || '',
        city: b.city || '',
        state: b.state || '',
        postalCode: b.postalCode || '',
      }));

      // Create the batch BEFORE enqueuing jobs so the webhook can
      // always attribute outcomes back to a batchId — even the
      // fast-completing first job. Batch tracking failure is
      // decoupled from the trigger (try/catch logs only).
      let batchId: string | undefined;
      if (filtered.length > 0) {
        try {
          const batch = await this.fixBatchService.createBatch({
            environment,
            businessIds: filtered.map((b) => String(b._id)),
            city: args.city,
            recipientEmails:
              this.configService.get<string[]>('app.notifyEmails') ??
              [],
          });
          batchId = batch?.batchId;
        } catch (err: any) {
          this.logger.warn(
            `[RESOLVE] batch create failed: ${err?.message}`,
          );
        }
      }

      const { created } = await this.botJobService.createJobs({
        records,
        type: BotJobType.RESOLVE_BUSINESS,
      });

      return { created, skippedAlreadyDone, batchId };
    } finally {
      await conn.close();
    }
  }

  // ────────────────────────────────────────────────────────────
  // PUBLIC: bulk re-run for the operator's "Re-resolve flagged &
  // unresolved" button. Re-enqueues the full work-set:
  //   (a) flagged-for-review                  (resolveStatus.status==='review')
  //   (b) never-resolved authentic candidates (no resolveStatus,
  //                                            isCvb===true,
  //                                            non-empty placeId)
  // Satellites (isLocationOf set) are excluded. Fully-fixed rows are
  // excluded by delegating to triggerResolve — the skip-fully-fixed
  // predicate lives there once and we don't re-implement it here.
  // Caps the per-call slice at 1000 so a single click can't enqueue
  // tens of thousands of jobs; returns `remaining` so the operator
  // (or a retry after CAPTCHA) can click again to continue.
  // ────────────────────────────────────────────────────────────

  async retriggerReview(args: {
    environment: string;
    limit?: number;
  }): Promise<{
    created: number;
    remaining: number;
    batchId?: string;
  }> {
    const HARD_CAP = 1000;
    const limit = Math.min(
      Math.max(1, args.limit ?? HARD_CAP),
      HARD_CAP,
    );

    const conn = await this.openTargetConn(args.environment);
    let targetIds: string[];
    let total: number;
    try {
      const Business = this.businessModel(conn);
      // The OR criterion already excludes 'done' rows (review status
      // ≠ done; missing resolveStatus has no status at all), so a
      // separate DB-level fully-fixed filter is unnecessary — the
      // in-app predicate inside triggerResolve handles the residual
      // edge cases ('done' rows that somehow re-entered the set).
      const candidateQuery: Record<string, any> = {
        isDeleted: { $ne: true },
        // Standalone only — satellites are intentionally inactive and
        // must never be queued through Google. Same shape used by the
        // data-repair activation queue.
        $and: [
          {
            $or: [
              { isLocationOf: { $exists: false } },
              { isLocationOf: null },
            ],
          },
          {
            $or: [
              { 'resolveStatus.status': 'review' },
              {
                $and: [
                  {
                    $or: [
                      { resolveStatus: { $exists: false } },
                      { resolveStatus: null },
                    ],
                  },
                  { isCvb: true },
                  { placeId: { $type: 'string', $ne: '' } },
                ],
              },
            ],
          },
        ],
      };

      total = await Business.countDocuments(candidateQuery);
      const docs = await Business.find(candidateQuery)
        .select('_id')
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
      targetIds = (docs as any[]).map((d) => String(d._id));
    } finally {
      await conn.close();
    }

    if (targetIds.length === 0) {
      return { created: 0, remaining: 0 };
    }

    // Delegate the heavy lifting — skip-fully-fixed filter, FixBatch
    // creation, and resolve_business job enqueue all live inside
    // triggerResolve. city: undefined (mixed set, the email subject
    // omits the city label).
    const result = await this.triggerResolve({
      environment: args.environment,
      businessIds: targetIds,
      force: false,
      city: undefined,
    });

    return {
      created: result.created,
      remaining: Math.max(0, total - targetIds.length),
      batchId: result.batchId,
    };
  }

  // ────────────────────────────────────────────────────────────
  // WEBHOOK: process resolve results from the bot
  // ────────────────────────────────────────────────────────────

  async handleResolveWebhook(
    payload: ResolveWebhookPayload,
  ): Promise<{ status: 'done' | 'review'; reason?: string }> {
    const {
      businessId, environment, resolvedPlaceId, resolvedName, hoursRaw,
      rating, userRatingCount, coverUrl, googleCategory,
      googleFormattedAddress,
    } = payload;
    let { error, placeIdNote } = payload;

    // Tolerate older bot deployments that signalled equals-building via
    // the hard `error` field. That was never a real bot error — the
    // page loaded, hours scraped, only the placeId upgrade was skipped.
    // Convert it to the soft placeIdNote signal so it stops poisoning
    // hours through the bot_error gate below.
    if (error === 'resolved_placeid_equals_building') {
      placeIdNote = placeIdNote ?? 'equals_building';
      error = undefined;
    }

    if (!businessId || !environment) {
      throw new Error('resolve webhook missing businessId/environment');
    }

    // Per-batch attribution helper. Fully decoupled — every failure is
    // swallowed so a bookkeeping issue can never poison the cascade
    // outcome we're about to return.
    const recordOutcomeSafe = async (
      outcome: import('./fix-batch.service').FixBatchOutcome,
    ): Promise<void> => {
      try {
        await this.fixBatchService.recordOutcome(outcome);
      } catch (err: any) {
        this.logger.warn(
          `[RESOLVE] recordOutcome failed for ${outcome.businessId}: ` +
            `${err?.message}`,
        );
      }
    };

    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);
      const business = (await Business.findById(
        new mongoose.Types.ObjectId(businessId),
      ).lean()) as any;

      if (!business) {
        this.logger.warn(`[RESOLVE] business ${businessId} not found`);
        await recordOutcomeSafe({
          businessId,
          businessName: resolvedName ?? '',
          hoursWritten: false,
          ratingWritten: false,
          coverSynced: false,
          taxonomyCorrected: false,
          fullyFixed: false,
          needsReview: true,
          reviewReason: 'business_not_found',
        });
        return { status: 'review', reason: 'business_not_found' };
      }

      // Bot reported an error mid-run: flag, never silently no-op.
      // Neither side was actually evaluated, so per-field statuses
      // both inherit the error string for visibility.
      if (error) {
        await this.writeResolveStatus(Business, businessId, {
          status: 'review',
          reason: `bot_error:${error}`,
          hours: `review:bot_error:${error}`,
          placeId: `review:bot_error:${error}`,
          resolvedName: resolvedName ?? null,
          resolvedPlaceId: resolvedPlaceId ?? null,
          hoursRaw: hoursRaw ?? [],
          checkedAt: new Date(),
        });
        await recordOutcomeSafe({
          businessId,
          businessName: business.name ?? '',
          hoursWritten: false,
          ratingWritten: false,
          coverSynced: false,
          taxonomyCorrected: false,
          fullyFixed: false,
          needsReview: true,
          reviewReason: `bot_error:${error}`,
        });
        return { status: 'review', reason: 'bot_error' };
      }

      // ── CONFIDENCE GATE: never write anything when names disagree ──
      // Still gates BOTH hours and placeId writes — a name miss means
      // we'd be writing to the wrong business doc.
      const conf = compareNames(business.name, resolvedName);
      if (!conf.match) {
        this.logger.warn(
          `[RESOLVE] name mismatch for ${businessId}: ` +
            `stored="${normalizeName(business.name)}" ` +
            `resolved="${normalizeName(resolvedName ?? '')}"`,
        );
        await this.writeResolveStatus(Business, businessId, {
          status: 'review',
          reason: 'name_mismatch',
          hours: 'review:name_mismatch',
          placeId: 'review:name_mismatch',
          resolvedName: resolvedName ?? null,
          resolvedPlaceId: resolvedPlaceId ?? null,
          hoursRaw: hoursRaw ?? [],
          confidence: conf,
          checkedAt: new Date(),
        });
        await recordOutcomeSafe({
          businessId,
          businessName: business.name ?? '',
          hoursWritten: false,
          ratingWritten: false,
          coverSynced: false,
          taxonomyCorrected: false,
          fullyFixed: false,
          needsReview: true,
          reviewReason: 'name_mismatch',
        });
        return { status: 'review', reason: 'name_mismatch' };
      }

      // ── DECOUPLED PER-FIELD RESOLUTION ──
      // Hours and placeId are evaluated independently. Either may
      // succeed alone; we write the successful side and flag the
      // other on resolveStatus. Overall .status = 'done' only when
      // hours actually parsed onto regularTiming.weekDays — empty
      // hoursRaw is treated as a captured-nothing case (operator
      // re-resolves) rather than a terminal success.
      const hoursResult = parseHoursRaw(hoursRaw);

      // hoursStatus is one of:
      //   'done'                                      — at least one day
      //                                                 parsed and
      //                                                 written to
      //                                                 regularTiming
      //                                                 .weekDays
      //   'review:no_hours_captured'                  — hoursRaw was []
      //                                                 (bot captured
      //                                                 nothing, or
      //                                                 Google had no
      //                                                 hours panel) —
      //                                                 surface for
      //                                                 re-resolve
      //                                                 instead of
      //                                                 silently passing
      //                                                 the placeholder
      //   'review:hours_shape:<err>'                  — non-array input
      //   'review:hours_no_days_parsed'               — lines present but
      //                                                 every day rejected
      let hoursStatus: string;

      // placeId outcome — purely informational. Never gates the
      // business's overall status (hours owns that). Three terminals:
      //   'done'                          — got a valid ChIJ
      //   'review:placeid_equals_building' — bot saw only the input
      //                                     building id on the page;
      //                                     no upgrade is available
      //                                     (operator-actionable in
      //                                     the placeId review tab)
      //   'review:placeid_not_found_chij'  — no ChIJ at all on the
      //                                     page (Google data limit)
      const placeIdIsChIJ = isValidChIJPlaceId(resolvedPlaceId);
      const placeIdStatus: string = placeIdIsChIJ
        ? 'done'
        : placeIdNote === 'equals_building'
          ? 'review:placeid_equals_building'
          : 'review:placeid_not_found_chij';

      const set: Record<string, any> = {};
      const resolveStatusBody: Record<string, any> = {
        placeId: placeIdStatus,
        resolvedName,
        resolvedPlaceId: resolvedPlaceId ?? null,
        hoursRaw: hoursRaw ?? [],
        confidence: conf,
        checkedAt: new Date(),
      };

      if (hoursResult.kind === 'empty') {
        // hoursRaw arrived empty. Previously this was treated as a
        // terminal "Google had no hours panel" success (hoursNote
        // sentinel + hours='done'), but we can't tell that case apart
        // from the bot simply failing to capture hours — and the
        // resulting hours='done' silently certified the seed
        // placeholder regularTiming as legit. Send to review so the
        // operator re-resolves, and leave regularTiming untouched
        // (still the placeholder, but no longer reads as complete).
        hoursStatus = 'review:no_hours_captured';
      } else if (hoursResult.kind === 'shape') {
        hoursStatus = `review:hours_shape:${hoursResult.shapeError ?? 'unknown'}`;
      } else if (hoursResult.kind === 'none_parsed') {
        // Lines were present but nothing reduced to a writable day.
        // Don't touch regularTiming. Send to review so the operator can
        // look at the raw lines and decide.
        hoursStatus = 'review:hours_no_days_parsed';
        resolveStatusBody.hoursUnparsedDays = hoursResult.unparsedDays;
      } else {
        // FIX B: per-day independent. Overlay only the days that parsed
        // cleanly onto the existing stored regularTiming.weekDays —
        // leave any day we couldn't parse at its prior value (NOT
        // defaulting to Closed). Unrecognised weekdays don't appear in
        // parsedDays.
        //
        // Real PinnTag shape: regularTiming.weekDays.{day}. If the
        // stored doc is still on the legacy flat shape (no weekDays
        // nesting — the 8,609 placeholder rows), we promote it to the
        // new shape on first resolve: the day keys we DON'T overwrite
        // come from defaultRegularTiming().weekDays so the resulting
        // doc is always fully schema-correct.
        const stored = business.regularTiming;
        const storedWeekDays =
          stored &&
          typeof stored === 'object' &&
          stored.weekDays &&
          typeof stored.weekDays === 'object'
            ? stored.weekDays
            : (defaultRegularTiming() as any).weekDays;

        set.regularTiming = {
          weekDays: {
            ...storedWeekDays,
            ...hoursResult.parsedDays,
          },
        };
        hoursStatus = 'done';
        if (hoursResult.unparsedDays.length > 0) {
          resolveStatusBody.hoursUnparsedDays = hoursResult.unparsedDays;
        }
      }

      resolveStatusBody.hours = hoursStatus;

      if (placeIdIsChIJ) {
        if (business.placeId !== resolvedPlaceId) {
          // Upgrade from the stored (likely building) id to the
          // discovered business id. Record both for audit.
          set.placeId = resolvedPlaceId;
          resolveStatusBody.oldPlaceId = business.placeId ?? null;
          resolveStatusBody.newPlaceId = resolvedPlaceId;
        } else {
          resolveStatusBody.placeIdUnchanged = true;
        }
      }

      // ── EXTRA-CHEAP FIELDS (all decoupled) ──
      // None of these gate the overall status — they're independent
      // per-field writes captured from the same panel visit.

      // rating: write whenever Google returned a number. Google's
      // public rating is always the freshest value, so overwrite the
      // stored one even if it already had something.
      if (typeof rating === 'number' && Number.isFinite(rating)) {
        set.rating = rating;
        resolveStatusBody.rating = 'done';
      }

      // userRatingCount: same rule as rating.
      if (
        typeof userRatingCount === 'number' &&
        Number.isFinite(userRatingCount)
      ) {
        set.userRatingCount = userRatingCount;
        resolveStatusBody.userRatingCount = 'done';
      }

      // cover (DEFERRED B2 upload): only queue when the business has
      // NO cover yet. The strict guard is "absent or empty string" —
      // any non-empty value (default seed cover, prior bot cover,
      // operator-uploaded) is left untouched. The raw Google URL is
      // staged on pendingCoverUrl; CoverB2SyncService later does the
      // download → B2 → write final cover swap as a separate batch
      // job (no Playwright needed there).
      if (typeof coverUrl === 'string' && coverUrl.startsWith('http')) {
        const existingCover = business.cover;
        const hasCover =
          typeof existingCover === 'string' && existingCover.length > 0;
        if (!hasCover) {
          set.pendingCoverUrl = coverUrl;
          resolveStatusBody.cover = 'pending_b2';
        } else {
          resolveStatusBody.cover = 'skipped_has_cover';
        }
      }

      // ── Google category (AUTO-APPLY when mapped) ──
      // Capture the raw Google category line and decide what to do
      // with it. The one-click "Fix" cascade auto-applies the
      // proposed taxonomy ONLY when the Google string is present in
      // GOOGLE_CATEGORY_MAP — unmapped strings stay flagged for the
      // operator to handle via the data-repair "Fix taxonomy" tab.
      //
      // Four terminal categoryStatus values:
      //   'no_google_cat' — Google didn't surface a category
      //   'correct'       — current already matches the mapping (or
      //                     was just auto-applied on this run)
      //   'unmapped'      — google string isn't in GOOGLE_CATEGORY_MAP
      //                     (proposed* not staged because we have no
      //                      proposal)
      //   'mismatch'      — kept ONLY as an in-flight value; if a
      //                     mapping is found here it's auto-applied
      //                     within this same updateOne. A persistent
      //                     'mismatch' on a business doc can only
      //                     come from the legacy flag-only path
      //                     before this cascade existed.
      //
      // "Never overwrite a 'correct' mapping" is honoured because the
      // sameIndustry+sameCats branch short-circuits to 'correct' with
      // zero writes — no taxonomy mutation when we're already right.
      let categoryStatus: string;
      if (typeof googleCategory === 'string' && googleCategory.trim()) {
        const trimmed = googleCategory.trim();
        set.googleCategory = trimmed;

        const mapping = lookupGoogleCategory(trimmed);
        if (!mapping) {
          categoryStatus = 'unmapped';
          // Clear any stale proposed from a prior resolve — the new
          // googleCategory string is unmapped, so we can't suggest.
          set.proposedIndustry = null;
          set.proposedCategories = null;
        } else {
          const currentIndustry = business.businessIndustry
            ? String(business.businessIndustry)
            : '';
          const currentCats = Array.isArray(business.businessCategories)
            ? business.businessCategories
            : [];
          const sameIndustry = currentIndustry === mapping.industryId;
          const sameCats =
            canonicalCategoryIds(currentCats) ===
            canonicalCategoryIds(mapping.categoryIds);

          if (sameIndustry && sameCats) {
            categoryStatus = 'correct';
            set.proposedIndustry = null;
            set.proposedCategories = null;
          } else {
            // AUTO-APPLY (step 2 of the cascade): mapping exists +
            // current taxonomy differs from it ⇒ write the mapped
            // industry + categories now, mark 'correct', clear any
            // proposed* from a prior flag-only run. Single updateOne
            // below carries everything atomically.
            categoryStatus = 'correct';
            set.businessIndustry = new mongoose.Types.ObjectId(
              mapping.industryId,
            );
            set.businessCategories = mapping.categoryIds.map(
              (id) => new mongoose.Types.ObjectId(id),
            );
            set.proposedIndustry = null;
            set.proposedCategories = null;
            resolveStatusBody.categoryAutoApplied = {
              googleCategory: trimmed,
              industryId: mapping.industryId,
              categoryIds: mapping.categoryIds,
            };
          }
        }
      } else {
        categoryStatus = 'no_google_cat';
        // Don't clobber a previously-flagged status: only set this
        // status when there's nothing else stored. (set is local to
        // this run; this just won't override prior proposed* on the
        // business doc — those stay until the next resolve does grab
        // a category.)
      }
      set.categoryStatus = categoryStatus;
      resolveStatusBody.category = categoryStatus;

      // ── Google formatted address (RAW, flag-only) ──
      // Capture the raw single-line address authentically. Component
      // parse (libpostal → road/house/city/state/postcode/country) and
      // the address_mismatch comparison against the stored
      // address1/city/state/postalCode are intentionally NOT wired up
      // here yet — node-postal is a system-level C dependency
      // (libpostal-dev + ~2GB data) and the API box doesn't have it.
      // Until that decision is made we set addressStatus to
      // 'address_unparsed' so the operator can review via the Fix
      // address tab. NEVER auto-overwrite address1/city/state/etc.
      //
      // When the parser lands later this block will branch to
      // 'address_mismatch' (writes set.proposedAddress) or 'correct'
      // (no proposal) instead of the unconditional 'address_unparsed'.
      if (
        typeof googleFormattedAddress === 'string' &&
        googleFormattedAddress.trim()
      ) {
        const raw = googleFormattedAddress.trim();
        set.googleFormattedAddress = raw;
        set.addressStatus = 'address_unparsed';
        resolveStatusBody.address = 'address_unparsed';
      }

      // Remember whether we staged a pendingCoverUrl on this run —
      // determines whether step 3 of the cascade fires after the
      // main updateOne returns below.
      const stagedPendingCover =
        typeof set.pendingCoverUrl === 'string' &&
        set.pendingCoverUrl.length > 0;

      // ── DECOUPLE — HOURS OWNS OVERALL STATUS ──
      // The primary goal of the resolve queue is to land authentic
      // hours on the business doc. PlaceId is a bonus upgrade — when
      // it succeeds we record the new ChIJ; when it doesn't we leave
      // the stored placeId untouched. The "Needs review" tab should
      // surface the business ONLY when hours actually failed, never
      // when only the placeId upgrade was skipped. A business with
      // real hours + its original placeId IS done.
      const overallStatus: 'done' | 'review' =
        hoursStatus === 'done' ? 'done' : 'review';
      resolveStatusBody.status = overallStatus;
      if (overallStatus === 'review') {
        // Hours-side reason is the actionable signal here; placeId
        // is excluded from the top-level reason on purpose so it
        // never sends an hours-done business to review.
        resolveStatusBody.reason = hoursStatus;
      }

      set.resolveStatus = resolveStatusBody;

      await Business.updateOne(
        { _id: new mongoose.Types.ObjectId(businessId) },
        { $set: set },
      );

      this.logger.log(
        `[RESOLVE] ${businessId} ${overallStatus} — ` +
          `hours=${hoursStatus} placeId=${placeIdStatus} ` +
          `category=${categoryStatus} ` +
          `address=${set.addressStatus ?? 'absent'} ` +
          `(wrote: ${
            [
              set.regularTiming ? 'regularTiming' : null,
              set.placeId ? 'placeId' : null,
              set.businessIndustry ? 'businessIndustry' : null,
              set.businessCategories ? 'businessCategories' : null,
              stagedPendingCover ? 'pendingCoverUrl' : null,
              set.googleFormattedAddress ? 'googleFormattedAddress' : null,
            ]
              .filter(Boolean)
              .join(',') || 'resolveStatus_only'
          })`,
      );

      // ── Step 3 of the one-click "Fix" cascade — auto cover sync ──
      // The webhook just staged pendingCoverUrl on this business; run
      // the existing CoverB2SyncService inline so the cover lands in
      // the same request, no separate "Sync pending covers" click
      // needed. Failure is fully decoupled — logged only, never
      // surfaces back through the webhook response. Steps 1 (hours +
      // friends) and 2 (taxonomy auto-apply) already succeeded.
      //
      // `coverFinalSynced` reflects whether the actual B2 upload landed
      // (used for batch attribution — a 'skipped:cover_already_set'
      // still counts as a cover win because the business now has a
      // cover one way or another).
      let coverFinalSynced = false;
      if (stagedPendingCover) {
        try {
          const outcome = await this.coverB2SyncService.syncOneBusiness(
            environment,
            businessId,
          );
          coverFinalSynced =
            outcome.outcome === 'synced' ||
            (outcome.outcome === 'skipped' &&
              outcome.reason === 'cover_already_set');
          this.logger.log(
            `[RESOLVE-CASCADE] ${businessId} cover_sync=` +
              `${outcome.outcome}` +
              (outcome.reason ? `:${outcome.reason}` : ''),
          );
        } catch (err: any) {
          this.logger.warn(
            `[RESOLVE-CASCADE] ${businessId} cover_sync_error: ` +
              `${err?.message}`,
          );
        }
      }

      // ── Batch attribution (per-business outcome) ──
      // Translate the in-flight `set` payload into the outcome buckets
      // FixBatchService increments. "fullyFixed" mirrors the same
      // condition triggerResolve uses to skip on retry — both must
      // agree so a fully-fixed business isn't re-enqueued AND gets
      // credited in the batch counters.
      const hadStaleMismatch =
        business.categoryStatus === 'mismatch' && !set.businessIndustry;
      const hasPendingAfter = stagedPendingCover && !coverFinalSynced;
      const fullyFixed =
        overallStatus === 'done' &&
        !hadStaleMismatch &&
        !hasPendingAfter;
      await recordOutcomeSafe({
        businessId,
        businessName: business.name ?? '',
        hoursWritten: !!set.regularTiming,
        ratingWritten: typeof set.rating === 'number',
        coverSynced: coverFinalSynced,
        taxonomyCorrected: !!set.businessIndustry,
        fullyFixed,
        needsReview: overallStatus === 'review',
        reviewReason:
          overallStatus === 'review'
            ? String(resolveStatusBody.reason ?? hoursStatus)
            : undefined,
      });

      return {
        status: overallStatus,
        reason: overallStatus === 'review'
          ? resolveStatusBody.reason
          : undefined,
      };
    } finally {
      await conn.close();
    }
  }

  // ────────────────────────────────────────────────────────────
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
      conn.models['ResolveBusiness'] ||
      conn.model('ResolveBusiness', LOOSE_SCHEMA, 'businesses')
    );
  }

  private async writeResolveStatus(
    Business: mongoose.Model<any>,
    businessId: string,
    resolveStatus: Record<string, any>,
  ): Promise<void> {
    await Business.updateOne(
      { _id: new mongoose.Types.ObjectId(businessId) },
      { $set: { resolveStatus } },
    );
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
