// Shared source of truth for the 11-criterion quality gate.
//
// Both the migration service (short-circuit, first-failing-reason, for
// gated migration eligibility) and the Business Console (per-criterion
// booleans, persisted onto gateStatus for filtering/facets) call the
// helpers in this file. If you change a criterion here, both surfaces
// pick the change up on the next run.
//
// c1-c7 correspond to the existing gated-migration checks. c9 corresponds
// to the migration service's "1b. verified_placeId" check (renumbered to
// c9 so c8 stays reserved for future work). c10 checks the
// emailVerification subdoc that the email_scrape stage populates.
// c11 has no backing stage yet and always returns false — a comment
// below marks the exact line to remove when that stage lands.

import { SEED_DEFAULT_COVER } from '../activation/seed-defaults';

export const US_LAT_MIN = 24;
export const US_LAT_MAX = 50;
export const US_LNG_MIN = -125;
export const US_LNG_MAX = -66;

export const URL_RE = /^\s*(https?:\/\/|www\.)/i;
export const PHONE_RE = /^\+?[\d\s\-().]{7,}$/;
export const COUNTY_RE = /county/i;
export const GOOGLE_HOST_RE = /googleusercontent/i;
export const MEDIA_STAGING_RE = /media-staging\.pinntag\.com/i;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function extractCoords(
  doc: Record<string, any>,
): { lat: number; lng: number } | null {
  const lat = isFiniteNumber(doc.latitude)
    ? doc.latitude
    : isFiniteNumber(doc.lat)
      ? doc.lat
      : isFiniteNumber(doc?.location?.coordinates?.[1])
        ? doc.location.coordinates[1]
        : null;
  const lng = isFiniteNumber(doc.longitude)
    ? doc.longitude
    : isFiniteNumber(doc.lng)
      ? doc.lng
      : isFiniteNumber(doc?.location?.coordinates?.[0])
        ? doc.location.coordinates[0]
        : null;
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

// ── Individual criterion predicates ─────────────────────────────────────

export function c1_active_outlet(doc: Record<string, any>): boolean {
  return (
    doc.isActive === true &&
    typeof doc.activatedOutletsLength === 'number' &&
    doc.activatedOutletsLength >= 1
  );
}

export function c2_real_cover(doc: Record<string, any>): boolean {
  const cover = typeof doc.cover === 'string' ? doc.cover : '';
  if (!cover) return false;
  if (cover === SEED_DEFAULT_COVER) return false;
  if (GOOGLE_HOST_RE.test(cover)) return false;
  return MEDIA_STAGING_RE.test(cover);
}

export function c3_real_hours(doc: Record<string, any>): boolean {
  const rs = doc.resolveStatus;
  return (
    !!rs &&
    rs.hours === 'done' &&
    Array.isArray(rs.hoursRaw) &&
    rs.hoursRaw.length > 0
  );
}

export function c4_taxonomy_present(doc: Record<string, any>): boolean {
  return (
    !!doc.businessIndustry &&
    Array.isArray(doc.businessCategories) &&
    doc.businessCategories.length > 0
  );
}

export function c5_valid_address(doc: Record<string, any>): boolean {
  const rawAddr =
    typeof doc.addressLine1 === 'string' ? doc.addressLine1.trim() : '';
  if (!rawAddr) return false;
  if (URL_RE.test(rawAddr)) return false;
  if (PHONE_RE.test(rawAddr)) return false;
  const city = typeof doc.city === 'string' ? doc.city.trim() : '';
  if (!city) return false;
  if (COUNTY_RE.test(city)) return false;
  return true;
}

export function c6_singleton_placeId(
  doc: Record<string, any>,
  placeIdCounts: Map<string, number>,
): boolean {
  const placeId = typeof doc.placeId === 'string' ? doc.placeId.trim() : '';
  if (!placeId) return false;
  return (placeIdCounts.get(placeId) ?? 0) <= 1;
}

export function c7_domestic_coords(doc: Record<string, any>): boolean {
  const coords = extractCoords(doc);
  if (!coords) return false;
  if (coords.lat === 0 && coords.lng === 0) return false;
  const country = typeof doc.country === 'string' ? doc.country.trim() : '';
  if (country && country.toLowerCase() !== 'united states') return false;
  if (coords.lat < US_LAT_MIN || coords.lat > US_LAT_MAX) return false;
  if (coords.lng < US_LNG_MIN || coords.lng > US_LNG_MAX) return false;
  return true;
}

// c9 is the migration service's "1b. verified_placeId": passes if the
// placeId has NOT been proven wrong. Absent confidence PASSES here —
// only an explicit `resolveStatus.confidence.match === false` fails.
export function c9_verified_placeId(doc: Record<string, any>): boolean {
  return doc?.resolveStatus?.confidence?.match !== false;
}

// c10 checks the emailVerification subdoc populated by the email_scrape
// stage. Passes iff the source is 'website_scrape' AND a non-empty
// email is present. Any other source is treated as unverified for
// gating purposes — 'website_scrape' is the only provenance where we
// know the address was literally on the business's own page.
export function c10_verified_email(doc: Record<string, any>): boolean {
  const ev = doc?.emailVerification;
  if (!ev) return false;
  if (ev.source !== 'website_scrape') return false;
  const email = typeof ev.email === 'string' ? ev.email.trim() : '';
  return email.length > 0;
}

// c11 has no backing stage yet. Delete this whole function body and
// replace with the real predicate when the verified-name stage ships.
export function c11_verified_name(_doc: Record<string, any>): boolean {
  return false;
}

export type GateBooleans = {
  c1_active_outlet: boolean;
  c2_real_cover: boolean;
  c3_real_hours: boolean;
  c4_taxonomy_present: boolean;
  c5_valid_address: boolean;
  c6_singleton_placeId: boolean;
  c7_domestic_coords: boolean;
  c9_verified_placeId: boolean;
  c10_verified_email: boolean;
  c11_verified_name: boolean;
  passLegacy9: boolean;
  passPerfect11: boolean;
};

// Evaluate every criterion (no short-circuit) and return a per-criterion
// pass/fail map plus the two aggregates.
//
// passLegacy9 mirrors the current gated-migration eligibility: c1..c7
// AND c9. Named "Legacy 9" for continuity with the leadership headline
// number (the c1b renumber to c9 is why the count is off by one).
// passPerfect11 requires everything, including c10 and c11 — always
// false today because c11 has no data yet.
export function evaluateAllGates(
  doc: Record<string, any>,
  placeIdCounts: Map<string, number>,
): GateBooleans {
  const c1 = c1_active_outlet(doc);
  const c2 = c2_real_cover(doc);
  const c3 = c3_real_hours(doc);
  const c4 = c4_taxonomy_present(doc);
  const c5 = c5_valid_address(doc);
  const c6 = c6_singleton_placeId(doc, placeIdCounts);
  const c7 = c7_domestic_coords(doc);
  const c9 = c9_verified_placeId(doc);
  const c10 = c10_verified_email(doc);
  const c11 = c11_verified_name(doc);
  const passLegacy9 = c1 && c2 && c3 && c4 && c5 && c6 && c7 && c9;
  const passPerfect11 = passLegacy9 && c10 && c11;
  return {
    c1_active_outlet: c1,
    c2_real_cover: c2,
    c3_real_hours: c3,
    c4_taxonomy_present: c4,
    c5_valid_address: c5,
    c6_singleton_placeId: c6,
    c7_domestic_coords: c7,
    c9_verified_placeId: c9,
    c10_verified_email: c10,
    c11_verified_name: c11,
    passLegacy9,
    passPerfect11,
  };
}

// Short-circuit variant matching the migration service's original
// gatedEvaluate output: returns the first failing reason using the
// same reason keys migration has always emitted. Preserved because the
// gated-migration UI displays these keys directly.
export type GateReason =
  | 'active_outlet'
  | 'unverified_placeId'
  | 'real_cover'
  | 'real_hours'
  | 'taxonomy_present'
  | 'valid_address'
  | 'singleton_placeId'
  | 'domestic_coords'
  | 'missing_source_doc';

export function evaluateGateShortCircuit(
  doc: Record<string, any> | undefined,
  placeIdCounts: Map<string, number>,
): { ok: true } | { ok: false; reason: GateReason } {
  if (!doc) return { ok: false, reason: 'missing_source_doc' };
  if (!c1_active_outlet(doc)) return { ok: false, reason: 'active_outlet' };
  if (!c9_verified_placeId(doc))
    return { ok: false, reason: 'unverified_placeId' };
  if (!c2_real_cover(doc)) return { ok: false, reason: 'real_cover' };
  if (!c3_real_hours(doc)) return { ok: false, reason: 'real_hours' };
  if (!c4_taxonomy_present(doc))
    return { ok: false, reason: 'taxonomy_present' };
  if (!c5_valid_address(doc)) return { ok: false, reason: 'valid_address' };
  if (!c6_singleton_placeId(doc, placeIdCounts))
    return { ok: false, reason: 'singleton_placeId' };
  if (!c7_domestic_coords(doc)) return { ok: false, reason: 'domestic_coords' };
  return { ok: true };
}

export const GATE_CRITERIA = [
  'c1_active_outlet',
  'c2_real_cover',
  'c3_real_hours',
  'c4_taxonomy_present',
  'c5_valid_address',
  'c6_singleton_placeId',
  'c7_domestic_coords',
  'c9_verified_placeId',
  'c10_verified_email',
  'c11_verified_name',
] as const;

export type GateCriterionKey = (typeof GATE_CRITERIA)[number];

export const GATE_CRITERIA_LABELS: Record<GateCriterionKey, string> = {
  c1_active_outlet: 'Active outlet',
  c2_real_cover: 'Real cover',
  c3_real_hours: 'Real hours',
  c4_taxonomy_present: 'Taxonomy present',
  c5_valid_address: 'Valid address',
  c6_singleton_placeId: 'Singleton placeId',
  c7_domestic_coords: 'Domestic coords',
  c9_verified_placeId: 'Verified placeId',
  c10_verified_email: 'Verified email',
  c11_verified_name: 'Verified name',
};
