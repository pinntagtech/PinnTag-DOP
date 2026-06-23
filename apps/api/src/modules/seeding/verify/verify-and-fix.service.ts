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
  totalBusinesses: number;
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

    const empty: VerifyAndFixResult = {
      totalBusinesses: 0,
      ready: 0,
      checkSummary: {
        name: 0, address: 0, coords: 0, hours: 0, hoursEncoding: 0,
        keys: 0, countryCode: 0, cover: 0, taxonomy: 0, outletLink: 0,
        resolve: 0,
      },
      autoFixable: {
        hours: 0, hoursEncoding: 0, keys: 0, countryCode: 0,
        coverQueued: 0, outletLink: 0,
      },
      needsManual: {
        address: 0, coords: 0, taxonomy: 0, resolve: 0, name: 0,
      },
      dryRun,
    };

    const session = await this.sessionService.findById(sessionId);
    const environment = (session as any).environment as string;

    const records = await this.recordService.findBySession(sessionId, {
      module: SeedingModules.BUSINESS,
    });

    // record by publishedId — used to recover the Google placeId for the
    // cover_sync bot job (the live Business doc may not carry it).
    const recordByPublishedId = new Map<string, any>();
    const publishedIds: mongoose.Types.ObjectId[] = [];
    for (const r of records as any[]) {
      const pid = r.publishedId;
      if (!pid) continue;
      recordByPublishedId.set(String(pid), r);
      if (mongoose.isValidObjectId(pid)) {
        publishedIds.push(new mongoose.Types.ObjectId(String(pid)));
      }
    }

    if (publishedIds.length === 0) return empty;

    const conn = await this.openTargetConn(environment);
    const result: VerifyAndFixResult = empty;
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

          // ── CHECK 12: EXCLUDE ──
          // Skip deferred-corrupt / genuinely-foreign rows (markers may be
          // absent today — this is a defensive guard) and any non-seeded
          // doc that slipped in (read-side mirror of the seeded write guard).
          if (
            b._deferredCorrupt === true ||
            b.genuinelyForeign === true ||
            (b.isCvb !== true && b.isFromCrawler !== true)
          ) {
            continue;
          }

          result.totalBusinesses++;

          const ctxOutlets = outletsByBiz.get(bizId) ?? [];
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
      if (coverJobs.length > 0) {
        if (dryRun) {
          result.autoFixable.coverQueued = coverJobs.length;
        } else {
          const { created } = await this.botJobService.createJobs({
            records: coverJobs.map((c) => ({
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

    await this.logService.log({
      sessionId,
      action: SeedingLogActions.VERIFY_AND_FIX,
      actor,
      message:
        `Verify & Fix (${dryRun ? 'dry-run' : 'applied'}): ` +
        `${result.ready}/${result.totalBusinesses} ready · ` +
        `auto-fixed hours=${result.autoFixable.hours} ` +
        `encoding=${result.autoFixable.hoursEncoding} ` +
        `keys=${result.autoFixable.keys} ` +
        `countryCode=${result.autoFixable.countryCode} ` +
        `outletLink=${result.autoFixable.outletLink} ` +
        `coversQueued=${result.autoFixable.coverQueued}`,
      metadata: result as any,
    });

    return result;
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
}
