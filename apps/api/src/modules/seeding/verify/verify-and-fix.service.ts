import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mongoose from 'mongoose';

import {
  EnvironmentUriKey,
  SeedingErrorMessages,
  SeedingLogActions,
  SeedingModules,
} from '../../../common/constants/seeding.constants';
import { BusinessStatus } from '../../../common/enums';
import { andSeeded } from '../data-repair/data-repair.constants';
import { BotJobType } from '../schemas/bot-job.schema';
import { BotJobService } from '../bot/bot-job.service';
import { SeedingLogService } from '../seeding-log.service';
import { SeedingRecordService } from '../seeding-record.service';
import { SeedingSessionService } from '../seeding-session.service';

// Loose schema — we read/write live Business + Outlet docs in the target DB
// and only touch a known subset of fields, so we don't want strict casting.
const LOOSE_SCHEMA = new mongoose.Schema<any>(
  {},
  { strict: false, timestamps: true },
);

const BATCH_SIZE = 50;

// ─── Small shared validators (mirrors of the import-time checks in
// scraper-adapter.ts so already-seeded data is audited by the SAME rules) ──

// Continental US + Alaska + Hawaii loose bounding box — identical to
// scraper-adapter's isUsCoord. Loose on purpose: a near-miss is a harmless
// false negative; the other direction would flag a legitimate US business.
function isUsCoord(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat >= 24 && lat <= 50 && lng >= -125 && lng <= -66) return true;
  if (lat >= 51 && lat <= 72 && lng >= -180 && lng <= -130) return true;
  if (lat >= 18 && lat <= 23 && lng >= -161 && lng <= -154) return true;
  return false;
}

// Country strings we accept as "US" for the genuinely-foreign EXCLUDE
// signature. Lower-cased, trimmed at comparison time. Mirrors the small
// COUNTRY_PHONE_MAP entries that resolve to +1.
const US_COUNTRY_NAMES = new Set([
  'united states',
  'united states of america',
  'usa',
  'u.s.a.',
  'us',
]);

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI',
  'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN',
  'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
]);

// A business "claims" to be US when its phone country code is +1 or its
// state is a US 2-letter code. Used by the coords corruption check — same
// signal set as data-repair's us_state_non_us_coords / plus1_non_us_coords.
function isStatedUs(b: any): boolean {
  if (b.countryCode === '+1') return true;
  const st = String(b.state ?? '').trim().toUpperCase();
  return st.length === 2 && US_STATE_CODES.has(st);
}

function hasRealCoords(b: any): boolean {
  const lat = b.latitude;
  const lng = b.longitude;
  if (lat == null || lng == null) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

// Junk/generic single-token names that carry no real identity.
const GENERIC_NAMES = new Set([
  'business', 'store', 'shop', 'restaurant', 'cafe', 'company',
  'n/a', 'na', 'none', 'null', 'unknown', 'test', 'untitled',
]);

const ADDR_URL_RE = /\.com|http|www\.|instagram|facebook/i;
const ADDR_PHONE_RE = /^\+?\d[\d\s\-()]+$/;

function isObjectIdLike(v: any): boolean {
  if (v == null) return false;
  if (v instanceof mongoose.Types.ObjectId) return true;
  return (
    (typeof v === 'string' || typeof v === 'object') &&
    mongoose.isValidObjectId(v)
  );
}

// ─── Hours helpers ─────────────────────────────────────────────────────────

const WEEK = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

function isClosedDay(d: any): boolean {
  if (!d) return true;
  if (d.isClosed === true) return true;
  const dur = d.duration;
  if (!dur) return true;
  return (
    dur.startHour === 0 &&
    dur.startMinute === 0 &&
    dur.endHour === 0 &&
    dur.endMinute === 0 &&
    d.isClosed !== false
  );
}

function isNineToFiveOpen(d: any): boolean {
  const dur = d?.duration;
  return (
    !!dur &&
    d.isClosed === false &&
    dur.startHour === 9 &&
    dur.startMinute === 0 &&
    dur.endHour === 17 &&
    dur.endMinute === 0
  );
}

// The seed placeholder regularTiming: Mon–Fri 09:00–17:00, Sat/Sun closed —
// OR an all-closed week. Either means "no real hours captured yet".
function isPlaceholderTiming(rt: any): boolean {
  const wd = rt?.weekDays;
  if (!wd) return false;
  const all95Placeholder =
    isNineToFiveOpen(wd.monday) &&
    isNineToFiveOpen(wd.tuesday) &&
    isNineToFiveOpen(wd.wednesday) &&
    isNineToFiveOpen(wd.thursday) &&
    isNineToFiveOpen(wd.friday) &&
    isClosedDay(wd.saturday) &&
    isClosedDay(wd.sunday);
  if (all95Placeholder) return true;
  const allClosed = WEEK.every((day) => isClosedDay(wd[day]));
  return allClosed;
}

// Returns a normalized copy of regularTiming + whether anything changed, per
// the LOCKED encoding: 24h open day → 0:00-23:59 (never 0-0 / 0-24); closed
// day → isClosed:true. Only OPEN days are touched; closed markers are left.
function computeHoursEncodingFix(rt: any): { changed: boolean; timing: any } {
  const wd = rt?.weekDays;
  if (!wd) return { changed: false, timing: rt };
  let changed = false;
  const nextWd: any = {};
  for (const day of WEEK) {
    const d = wd[day];
    if (!d || d.isClosed === true || !d.duration) {
      nextWd[day] = d;
      continue;
    }
    const dur = d.duration;
    const isZeroSpan =
      dur.startHour === 0 &&
      dur.startMinute === 0 &&
      dur.endHour === 0 &&
      dur.endMinute === 0;
    if (dur.endHour >= 24 || isZeroSpan) {
      // Legacy 0-24 or botched 0-0 open day → locked 0:00-23:59.
      nextWd[day] = {
        ...d,
        duration: {
          startHour: dur.startHour,
          startMinute: dur.startMinute,
          endHour: 23,
          endMinute: 59,
        },
        isClosed: false,
      };
      changed = true;
    } else {
      nextWd[day] = d;
    }
  }
  return changed
    ? { changed: true, timing: { ...rt, weekDays: nextWd } }
    : { changed: false, timing: rt };
}

// ─── Response shape ────────────────────────────────────────────────────────

export interface VerifyAndFixResult {
  // Count of PUBLISHED businesses that were audited (live Business docs in
  // the target DB). Excludes those skipped by CHECK 12.
  totalBusinesses: number;
  // Count of UNPUBLISHED records audited via record.transformedData — the
  // seed shape that WOULD be published. A ready-but-unpublished session
  // (e.g. fresh scraper import, 0 published) reports these here.
  unpublishedRecords: number;
  // Combined readiness across published + unpublished. An unpublished
  // record is "ready" when all pre-publish quality checks pass; the
  // post-publish-only items (outlets, cover bot) move to pendingPublish.
  ready: number;
  checkSummary: {
    name: number;
    address: number;
    coords: number;
    hours: number;
    hoursEncoding: number;
    keys: number;
    countryCode: number;
    cover: number;
    taxonomy: number;
    outletLink: number;
    resolve: number;
    placeId: number;
  };
  autoFixable: {
    hours: number;
    hoursEncoding: number;
    keys: number;
    countryCode: number;
    coverQueued: number;
    outletLink: number;
  };
  needsManual: {
    address: number;
    coords: number;
    taxonomy: number;
    resolve: number;
    name: number;
    placeId: number;
  };
  // Items that CANNOT be auto-fixed pre-publish — the operator publishes
  // first and these become normal published-path concerns. outletLink is
  // bumped once per unpublished record (outlets are created at publish
  // time); cover bumps when the seed carries a googleusercontent URL
  // (the post-publish cover_sync bot will replace it).
  pendingPublish: {
    outletLink: number;
    cover: number;
  };
  dryRun: boolean;
}

@Injectable()
export class VerifyAndFixService {
  private readonly logger = new Logger(VerifyAndFixService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly sessionService: SeedingSessionService,
    private readonly recordService: SeedingRecordService,
    private readonly botJobService: BotJobService,
    private readonly logService: SeedingLogService,
  ) {}

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

  async run(
    sessionId: string,
    opts: { dryRun: boolean; actor: string },
  ): Promise<VerifyAndFixResult> {
    const { dryRun, actor } = opts;

    const result: VerifyAndFixResult = {
      totalBusinesses: 0,
      unpublishedRecords: 0,
      ready: 0,
      checkSummary: {
        name: 0, address: 0, coords: 0, hours: 0, hoursEncoding: 0,
        keys: 0, countryCode: 0, cover: 0, taxonomy: 0, outletLink: 0,
        resolve: 0, placeId: 0,
      },
      autoFixable: {
        hours: 0, hoursEncoding: 0, keys: 0, countryCode: 0,
        coverQueued: 0, outletLink: 0,
      },
      needsManual: {
        address: 0, coords: 0, taxonomy: 0, resolve: 0, name: 0, placeId: 0,
      },
      pendingPublish: {
        outletLink: 0, cover: 0,
      },
      dryRun,
    };

    const session = await this.sessionService.findById(sessionId);
    const environment = (session as any).environment as string;

    // findBySession converts the controller's :id (Mongo _id hex) to
    // ObjectId before querying seedingrecords.sessionId — querying with
    // the human-readable "DOP-..." string here would return 0 records.
    const records = await this.recordService.findBySession(sessionId, {
      module: SeedingModules.BUSINESS,
    });

    // Partition: records WITH a valid publishedId go through the live-DB
    // path; those WITHOUT are audited against record.transformedData (the
    // seed doc that would be published).
    const recordByPublishedId = new Map<string, any>();
    const publishedIds: mongoose.Types.ObjectId[] = [];
    const unpublishedRecords: any[] = [];
    for (const r of records as any[]) {
      const pid = r.publishedId;
      if (pid && mongoose.isValidObjectId(pid)) {
        recordByPublishedId.set(String(pid), r);
        publishedIds.push(new mongoose.Types.ObjectId(String(pid)));
      } else {
        unpublishedRecords.push(r);
      }
    }

    if (publishedIds.length === 0 && unpublishedRecords.length === 0) {
      return result;
    }

    if (publishedIds.length > 0) {
      await this.auditPublished({
        environment,
        sessionId,
        dryRun,
        publishedIds,
        recordByPublishedId,
        result,
      });
    }

    if (unpublishedRecords.length > 0) {
      await this.auditUnpublished({
        dryRun,
        records: unpublishedRecords,
        result,
      });
    }

    await this.logService.log({
      sessionId,
      action: SeedingLogActions.VERIFY_AND_FIX,
      actor,
      message:
        `Verify & Fix (${dryRun ? 'dry-run' : 'applied'}): ` +
        `${result.ready}/${result.totalBusinesses + result.unpublishedRecords} ready ` +
        `(published=${result.totalBusinesses} unpublished=${result.unpublishedRecords}) · ` +
        `auto-fixed hours=${result.autoFixable.hours} ` +
        `encoding=${result.autoFixable.hoursEncoding} ` +
        `keys=${result.autoFixable.keys} ` +
        `countryCode=${result.autoFixable.countryCode} ` +
        `outletLink=${result.autoFixable.outletLink} ` +
        `coversQueued=${result.autoFixable.coverQueued} · ` +
        `pendingPublish outletLink=${result.pendingPublish.outletLink} ` +
        `cover=${result.pendingPublish.cover}`,
      metadata: result as any,
    });

    return result;
  }

  // ── PUBLISHED PATH ──────────────────────────────────────────────────────
  // Reads live Business + Outlet docs in the target DB and audits/fixes
  // them against the activation checklist. Unchanged behavior from the
  // pre-extension service — just extracted into a method.
  private async auditPublished(args: {
    environment: string;
    sessionId: string;
    dryRun: boolean;
    publishedIds: mongoose.Types.ObjectId[];
    recordByPublishedId: Map<string, any>;
    result: VerifyAndFixResult;
  }): Promise<void> {
    const {
      environment,
      sessionId,
      dryRun,
      publishedIds,
      recordByPublishedId,
      result,
    } = args;

    const conn = await this.openTargetConn(environment);
    const coverJobs: {
      businessId: string;
      businessName: string;
      placeId: string;
      environment: string;
    }[] = [];

    try {
      const Business =
        conn.models['VerifyBusiness'] ||
        conn.model('VerifyBusiness', LOOSE_SCHEMA, 'businesses');
      const Outlet =
        conn.models['VerifyOutlet'] ||
        conn.model('VerifyOutlet', LOOSE_SCHEMA, 'outlets');

      const businesses = await Business.find({
        _id: { $in: publishedIds },
      }).lean();

      // Active outlets for these businesses, grouped by business id.
      const outlets = await Outlet.find({
        business: { $in: publishedIds },
        isActive: true,
      })
        .lean()
        .exec();
      const outletsByBiz = new Map<string, any[]>();
      for (const o of outlets as any[]) {
        const key = String(o.business);
        const arr = outletsByBiz.get(key) ?? [];
        arr.push(o);
        outletsByBiz.set(key, arr);
      }

      for (let i = 0; i < businesses.length; i += BATCH_SIZE) {
        const batch = (businesses as any[]).slice(i, i + BATCH_SIZE);
        for (const b of batch) {
          const bizId = String(b._id);
          const ctxOutlets = outletsByBiz.get(bizId) ?? [];

          // ── CHECK 12: EXCLUDE ──
          // (a) The deferred-corrupt marker is set on OUTLETS via mongosh
          // (not in any schema), so check active outlets, not the business.
          // (b) Genuinely-foreign rows carry no marker — apply the
          // signature inline: non-US country AND coords outside the US
          // bbox. Don't waste cover-queue / key-set work on rows slated
          // for delete/deactivate.
          // (c) Read-side mirror of the seeded write guard.
          const hasDeferredCorruptOutlet = ctxOutlets.some(
            (o) => o._deferredCorrupt === true,
          );
          const countryStr = String(b.country ?? '')
            .trim()
            .toLowerCase();
          const isUsCountry =
            countryStr.length > 0 && US_COUNTRY_NAMES.has(countryStr);
          const coordsOutsideUs =
            hasRealCoords(b) && !isUsCoord(b.latitude, b.longitude);
          const genuinelyForeign =
            countryStr.length > 0 && !isUsCountry && coordsOutsideUs;

          if (
            hasDeferredCorruptOutlet ||
            genuinelyForeign ||
            (b.isCvb !== true && b.isFromCrawler !== true)
          ) {
            continue;
          }

          result.totalBusinesses++;

          const record = recordByPublishedId.get(bizId);

          // ── Build the auto-fix plan from the CURRENT state ──
          const set: Record<string, any> = {};
          const fixed = {
            hours: false,
            hoursEncoding: false,
            keys: false,
            countryCode: false,
            outletLink: false,
          };

          // KEYS (6) — set missing status/continueJourney defaults.
          if (b.status == null) {
            set.status = BusinessStatus.CONFETTI_SCREEN; // 4.1
            fixed.keys = true;
          }
          if (b.continueJourney == null) {
            set.continueJourney = false;
            fixed.keys = true;
          }

          // COUNTRYCODE (7) — set when missing (only when not clearly
          // non-US, so we never stamp a wrong +1). Wrong-+1 is report-only.
          if (!b.countryCode) {
            const nonUs =
              hasRealCoords(b) && !isUsCoord(b.latitude, b.longitude);
            if (!nonUs) {
              set.countryCode = '+1';
              fixed.countryCode = true;
            }
          }

          // HOURS ENCODING (5) — normalize 24h/closed encodings.
          const encFix = computeHoursEncodingFix(b.regularTiming);
          if (encFix.changed) {
            set.regularTiming = encFix.timing;
            fixed.hoursEncoding = true;
          }

          // HOURS (4) — if hoursRaw empty or regularTiming is a placeholder,
          // flip resolveStatus back to review so re-resolve re-fetches. Skip
          // if already flagged (idempotent).
          const rs = b.resolveStatus ?? {};
          const hoursRawEmpty =
            !Array.isArray(rs.hoursRaw) || rs.hoursRaw.length === 0;
          const placeholder = isPlaceholderTiming(
            encFix.changed ? encFix.timing : b.regularTiming,
          );
          const alreadyFlagged =
            rs.hours === 'review:no_hours_captured' && rs.status === 'review';
          if ((hoursRawEmpty || placeholder) && !alreadyFlagged) {
            set['resolveStatus.hours'] = 'review:no_hours_captured';
            set['resolveStatus.status'] = 'review';
            fixed.hours = true;
          }

          // OUTLET LINK (10) — backfill array desync when active outlets
          // exist (cannot conjure an outlet from nothing here).
          if (ctxOutlets.length >= 1) {
            const ids = ctxOutlets.map((o) => String(o._id));
            const outletsArr = Array.isArray(b.outlets)
              ? b.outlets.map(String)
              : [];
            const activatedArr = Array.isArray(b.activatedOutlets)
              ? b.activatedOutlets.map(String)
              : [];
            const missingOutlets = !ids.every((id) =>
              outletsArr.includes(id),
            );
            const missingActivated = !ids.every((id) =>
              activatedArr.includes(id),
            );
            const lenWrong = (b.activatedOutletsLength ?? 0) < ids.length;
            if (missingOutlets || missingActivated || lenWrong) {
              const merged = Array.from(new Set([...outletsArr, ...ids]));
              const mergedActivated = Array.from(
                new Set([...activatedArr, ...ids]),
              );
              set.outlets = merged.map(
                (id) => new mongoose.Types.ObjectId(id),
              );
              set.activatedOutlets = mergedActivated.map(
                (id) => new mongoose.Types.ObjectId(id),
              );
              set.activatedOutletsLength = mergedActivated.length;
              set.activeOutletsLength = mergedActivated.length;
              fixed.outletLink = true;
            }
          }

          // ── COVER (8): queue a cover_sync bot job (auto-fix via queue) ──
          const coverBad =
            !b.cover || /googleusercontent/i.test(String(b.cover));
          if (coverBad) {
            const placeId = String(
              record?.transformedData?.placeId ??
                record?.rawData?.placeId ??
                rs.resolvedPlaceId ??
                b.placeId ??
                '',
            );
            if (placeId) {
              coverJobs.push({
                businessId: bizId,
                businessName: String(b.name ?? ''),
                placeId,
                environment,
              });
            }
          }

          // ── Apply the auto-fixes (writes guarded to seeded docs) ──
          if (!dryRun && Object.keys(set).length > 0) {
            await Business.updateOne(andSeeded({ _id: b._id }), { $set: set });
            // Mirror onto the in-memory doc so the post-fix re-evaluation
            // below reflects the new state.
            if (set.status !== undefined) b.status = set.status;
            if (set.continueJourney !== undefined)
              b.continueJourney = set.continueJourney;
            if (set.countryCode !== undefined) b.countryCode = set.countryCode;
            if (set.regularTiming !== undefined)
              b.regularTiming = set.regularTiming;
            if (set['resolveStatus.hours'] !== undefined) {
              b.resolveStatus = {
                ...rs,
                hours: set['resolveStatus.hours'],
                status: set['resolveStatus.status'],
              };
            }
            if (set.outlets !== undefined) {
              b.outlets = set.outlets;
              b.activatedOutlets = set.activatedOutlets;
              b.activatedOutletsLength = set.activatedOutletsLength;
              b.activeOutletsLength = set.activeOutletsLength;
            }
          }

          // ── Evaluate all 11 checks on the (possibly fixed) doc ──
          const fail = this.evaluateChecks(b, ctxOutlets);

          // checkSummary — count every failing check (final state).
          for (const k of Object.keys(fail) as (keyof typeof fail)[]) {
            if (fail[k]) (result.checkSummary as any)[k]++;
          }

          // autoFixable — what we fixed (apply) / would fix (dryRun).
          if (fixed.hours) result.autoFixable.hours++;
          if (fixed.hoursEncoding) result.autoFixable.hoursEncoding++;
          if (fixed.keys) result.autoFixable.keys++;
          if (fixed.countryCode) result.autoFixable.countryCode++;
          if (fixed.outletLink) result.autoFixable.outletLink++;

          // needsManual — report-only failures requiring operator action.
          if (fail.address) result.needsManual.address++;
          if (fail.coords) result.needsManual.coords++;
          if (fail.taxonomy) result.needsManual.taxonomy++;
          if (fail.resolve) result.needsManual.resolve++;
          if (fail.name) result.needsManual.name++;

          // ready — passes ALL checks. Cover counts as failing until the
          // queued sync completes, so freshly-queued covers aren't "ready".
          const anyFail = Object.values(fail).some(Boolean);
          if (!anyFail) result.ready++;
        }
      }

      // ── Enqueue cover_sync jobs (createJobs filters to those w/ placeId) ──
      // Suppress duplicates: a business with an already-pending or running
      // cover_sync job must not be re-enqueued on repeated Apply runs.
      // Applied to dry-run too so the displayed count matches what an Apply
      // would actually create.
      if (coverJobs.length > 0) {
        const inflight = await this.botJobService.findInflightBusinessIds(
          BotJobType.COVER_SYNC,
          coverJobs.map((c) => c.businessId),
        );
        const fresh = coverJobs.filter((c) => !inflight.has(c.businessId));
        if (dryRun) {
          result.autoFixable.coverQueued = fresh.length;
        } else if (fresh.length > 0) {
          const { created } = await this.botJobService.createJobs({
            records: fresh.map((c) => ({
              placeId: c.placeId,
              businessId: c.businessId,
              businessName: c.businessName,
              environment: c.environment,
            })),
            sessionId,
            type: BotJobType.COVER_SYNC,
          });
          result.autoFixable.coverQueued = created;
        }
      }
    } finally {
      await conn.close();
    }
  }

  // ── UNPUBLISHED PATH ────────────────────────────────────────────────────
  // Audits record.transformedData (the seed shape that WOULD be published).
  // Field names differ from the live Business doc — notably `address1`
  // instead of `addressLine1`, string `industry`/`categories` instead of
  // ObjectId refs, and no resolveStatus/outlets exist pre-publish.
  // Auto-fixes write back to record.transformedData via dot-path $set;
  // post-publish-only items (outlet-link, cover-queue) move to
  // result.pendingPublish rather than autoFixable.
  private async auditUnpublished(args: {
    dryRun: boolean;
    records: any[];
    result: VerifyAndFixResult;
  }): Promise<void> {
    const { dryRun, records, result } = args;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      for (const r of batch) {
        const t = (r.transformedData ?? {}) as Record<string, any>;
        // Skip records that never reached the transformed stage — there's
        // nothing to evaluate yet (validation/transform pipeline first).
        if (!t || Object.keys(t).length === 0) continue;

        // ── EXCLUDE (mirror of published-side CHECK 12 for pre-publish) ──
        // deferred-corrupt is an outlet-only marker (no outlets exist
        // pre-publish), so only the genuinely-foreign signature applies.
        const countryStr = String(t.country ?? '').trim().toLowerCase();
        const isUsCountry =
          countryStr.length > 0 && US_COUNTRY_NAMES.has(countryStr);
        const coordsOutsideUs =
          hasRealCoords(t) && !isUsCoord(t.latitude, t.longitude);
        const genuinelyForeign =
          countryStr.length > 0 && !isUsCountry && coordsOutsideUs;
        if (genuinelyForeign) continue;

        result.unpublishedRecords++;

        // ── Build the auto-fix plan ──
        const set: Record<string, any> = {};
        const fixed = {
          hoursEncoding: false,
          keys: false,
          countryCode: false,
        };

        // KEYS — set missing status/continueJourney defaults.
        if (t.status == null) {
          set['transformedData.status'] = BusinessStatus.CONFETTI_SCREEN;
          fixed.keys = true;
        }
        if (t.continueJourney == null) {
          set['transformedData.continueJourney'] = false;
          fixed.keys = true;
        }

        // COUNTRYCODE — set when missing (only when not clearly non-US,
        // so we never stamp a wrong +1).
        if (!t.countryCode) {
          const nonUs =
            hasRealCoords(t) && !isUsCoord(t.latitude, t.longitude);
          if (!nonUs) {
            set['transformedData.countryCode'] = '+1';
            fixed.countryCode = true;
          }
        }

        // HOURS ENCODING — normalize 24h/zero-span encodings.
        const encFix = computeHoursEncodingFix(t.regularTiming);
        if (encFix.changed) {
          set['transformedData.regularTiming'] = encFix.timing;
          fixed.hoursEncoding = true;
        }

        // Apply (writes scoped to this record's _id; records are
        // DOP-owned by definition so no andSeeded equivalent is needed).
        if (!dryRun && Object.keys(set).length > 0) {
          await this.recordService.updateRecord(String(r._id), set);
          // Mirror onto the in-memory transformedData so the post-fix
          // evaluation below reflects the new state.
          if (set['transformedData.status'] !== undefined) {
            t.status = set['transformedData.status'];
          }
          if (set['transformedData.continueJourney'] !== undefined) {
            t.continueJourney = set['transformedData.continueJourney'];
          }
          if (set['transformedData.countryCode'] !== undefined) {
            t.countryCode = set['transformedData.countryCode'];
          }
          if (set['transformedData.regularTiming'] !== undefined) {
            t.regularTiming = set['transformedData.regularTiming'];
          }
        }

        // ── Evaluate seed-shape checks (post auto-fix) ──
        const fail = this.evaluateSeedChecks(t);

        // checkSummary — only count checks that actually apply pre-publish.
        // outletLink / resolve are not failures pre-publish; cover only
        // fails when MISSING (googleusercontent is acceptable and gets
        // bucketed into pendingPublish.cover below).
        if (fail.name) result.checkSummary.name++;
        if (fail.address) result.checkSummary.address++;
        if (fail.coords) result.checkSummary.coords++;
        if (fail.hours) result.checkSummary.hours++;
        if (fail.hoursEncoding) result.checkSummary.hoursEncoding++;
        if (fail.keys) result.checkSummary.keys++;
        if (fail.countryCode) result.checkSummary.countryCode++;
        if (fail.coverMissing) result.checkSummary.cover++;
        if (fail.taxonomy) result.checkSummary.taxonomy++;
        if (fail.placeId) result.checkSummary.placeId++;

        // autoFixable — what we fixed (apply) / would fix (dryRun).
        if (fixed.hoursEncoding) result.autoFixable.hoursEncoding++;
        if (fixed.keys) result.autoFixable.keys++;
        if (fixed.countryCode) result.autoFixable.countryCode++;

        // needsManual — what an operator must address (data-side gaps).
        if (fail.name) result.needsManual.name++;
        if (fail.address) result.needsManual.address++;
        if (fail.coords) result.needsManual.coords++;
        if (fail.taxonomy) result.needsManual.taxonomy++;
        if (fail.placeId) result.needsManual.placeId++;

        // pendingPublish — outlets are created at publish time, so every
        // unpublished record contributes. Cover bucket only when the seed
        // carries a googleusercontent URL the bot will replace.
        result.pendingPublish.outletLink++;
        if (fail.coverGoogleHost) result.pendingPublish.cover++;

        // "ready" pre-publish: all data-side checks pass. We deliberately
        // don't require outletLink/cover-queue/resolve here — those move
        // through the published path after the operator publishes.
        const dataSideFail =
          fail.name ||
          fail.address ||
          fail.coords ||
          fail.hours ||
          fail.hoursEncoding ||
          fail.keys ||
          fail.countryCode ||
          fail.coverMissing ||
          fail.taxonomy ||
          fail.placeId;
        if (!dataSideFail) result.ready++;
      }
    }
  }

  // Returns a map of checkName → failed(boolean) for one business.
  private evaluateChecks(
    b: any,
    activeOutlets: any[],
  ): {
    name: boolean;
    address: boolean;
    coords: boolean;
    hours: boolean;
    hoursEncoding: boolean;
    keys: boolean;
    countryCode: boolean;
    cover: boolean;
    taxonomy: boolean;
    outletLink: boolean;
    resolve: boolean;
  } {
    // 1. NAME
    const name = String(b.name ?? '').trim();
    const nameFail =
      name.length <= 2 || GENERIC_NAMES.has(name.toLowerCase());

    // 2. ADDRESS
    const addr = String(b.addressLine1 ?? '').trim();
    const addressFail =
      !addr || ADDR_URL_RE.test(addr) || ADDR_PHONE_RE.test(addr);

    // 3. COORDS
    let coordsFail = !hasRealCoords(b);
    if (!coordsFail && isStatedUs(b) && !isUsCoord(b.latitude, b.longitude)) {
      coordsFail = true;
    }

    // 4. HOURS
    const rs = b.resolveStatus ?? {};
    const wd = b.regularTiming?.weekDays;
    const hoursRawEmpty =
      !Array.isArray(rs.hoursRaw) || rs.hoursRaw.length === 0;
    const hoursFail =
      !wd ||
      isPlaceholderTiming(b.regularTiming) ||
      hoursRawEmpty ||
      rs.hours !== 'done';

    // 5. HOURS ENCODING
    const hoursEncodingFail = computeHoursEncodingFix(b.regularTiming).changed;

    // 6. KEYS
    const keysFail = b.status == null || b.continueJourney == null;

    // 7. COUNTRYCODE (missing OR wrong-+1 on non-US coords)
    let countryCodeFail = !b.countryCode;
    if (
      !countryCodeFail &&
      b.countryCode === '+1' &&
      hasRealCoords(b) &&
      !isUsCoord(b.latitude, b.longitude)
    ) {
      countryCodeFail = true;
    }

    // 8. COVER
    const coverFail =
      !b.cover || /googleusercontent/i.test(String(b.cover));

    // 9. TAXONOMY
    const cats = b.businessCategories;
    const taxonomyFail =
      !isObjectIdLike(b.businessIndustry) ||
      !Array.isArray(cats) ||
      cats.length === 0 ||
      !cats.every((c: any) => isObjectIdLike(c));

    // 10. OUTLET LINK
    let outletLinkFail = activeOutlets.length < 1;
    if (!outletLinkFail) {
      const ids = activeOutlets.map((o) => String(o._id));
      const outletsArr = Array.isArray(b.outlets) ? b.outlets.map(String) : [];
      const activatedArr = Array.isArray(b.activatedOutlets)
        ? b.activatedOutlets.map(String)
        : [];
      outletLinkFail =
        !ids.every((id) => outletsArr.includes(id)) ||
        !ids.every((id) => activatedArr.includes(id)) ||
        (b.activatedOutletsLength ?? 0) < 1;
    }

    // 11. RESOLVE
    const resolveFail = rs.status !== 'done';

    return {
      name: nameFail,
      address: addressFail,
      coords: coordsFail,
      hours: hoursFail,
      hoursEncoding: hoursEncodingFail,
      keys: keysFail,
      countryCode: countryCodeFail,
      cover: coverFail,
      taxonomy: taxonomyFail,
      outletLink: outletLinkFail,
      resolve: resolveFail,
    };
  }

  // Seed-shape evaluator for record.transformedData. Diffs from
  // evaluateChecks (live business):
  //   • address field is `address1`, not `addressLine1`
  //   • hours has no resolveStatus.hoursRaw → judged from regularTiming
  //     shape + placeholder check only
  //   • countryCode wrong-+1 logic is identical
  //   • cover is split into "missing" (counts as a fail) and
  //     "googleHost" (acceptable pre-publish, contributes to
  //     pendingPublish.cover)
  //   • taxonomy accepts STRING industry + non-empty STRING categories
  //     array (the seed shape — they're converted to ObjectIds at publish)
  //   • placeId presence is checked (needed for resolve + cover bot)
  //   • no outletLink / resolve (don't exist pre-publish)
  private evaluateSeedChecks(t: any): {
    name: boolean;
    address: boolean;
    coords: boolean;
    hours: boolean;
    hoursEncoding: boolean;
    keys: boolean;
    countryCode: boolean;
    coverMissing: boolean;
    coverGoogleHost: boolean;
    taxonomy: boolean;
    placeId: boolean;
  } {
    const name = String(t.name ?? '').trim();
    const nameFail =
      name.length <= 2 || GENERIC_NAMES.has(name.toLowerCase());

    const addr = String(t.address1 ?? '').trim();
    const addressFail =
      !addr || ADDR_URL_RE.test(addr) || ADDR_PHONE_RE.test(addr);

    let coordsFail = !hasRealCoords(t);
    if (!coordsFail && isStatedUs(t) && !isUsCoord(t.latitude, t.longitude)) {
      coordsFail = true;
    }

    const wd = t.regularTiming?.weekDays;
    const hoursFail = !wd || isPlaceholderTiming(t.regularTiming);

    const hoursEncodingFail = computeHoursEncodingFix(t.regularTiming).changed;

    const keysFail = t.status == null || t.continueJourney == null;

    let countryCodeFail = !t.countryCode;
    if (
      !countryCodeFail &&
      t.countryCode === '+1' &&
      hasRealCoords(t) &&
      !isUsCoord(t.latitude, t.longitude)
    ) {
      countryCodeFail = true;
    }

    const coverStr = String(t.cover ?? '');
    const coverMissing = !t.cover;
    const coverGoogleHost =
      !coverMissing && /googleusercontent/i.test(coverStr);

    // Pre-publish, industry+categories are STRINGS (e.g. "Food & Drinks" /
    // ["Restaurant"]). They're resolved to ObjectId refs at publish time.
    const indStr = String(t.industry ?? '').trim();
    const cats = t.categories;
    const taxonomyFail =
      indStr.length === 0 ||
      !Array.isArray(cats) ||
      cats.length === 0 ||
      !cats.every((c: any) => String(c ?? '').trim().length > 0);

    const placeIdFail = !t.placeId || String(t.placeId).trim().length === 0;

    return {
      name: nameFail,
      address: addressFail,
      coords: coordsFail,
      hours: hoursFail,
      hoursEncoding: hoursEncodingFail,
      keys: keysFail,
      countryCode: countryCodeFail,
      coverMissing,
      coverGoogleHost,
      taxonomy: taxonomyFail,
      placeId: placeIdFail,
    };
  }
}
