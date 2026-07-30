// Write-time hardening for Business docs. Prevents four classes of bad
// data from re-entering staging/pre-prod/prod after items 1-4 clean up:
//
//   1. `cover` / `coverThumbnail` / `logo` / `logoThumbnail` set to a
//      pinntag-assets Defaults/* placeholder URL (hides the record from
//      Cover Backfill, fails c2_real_cover).
//   2. `addressLine1` carrying a phone number, URL, hours-text, or a
//      non-postal free-text string (fails c5_valid_address; poisons city
//      derivation downstream).
//   3. `city` written as free text when `addressLine1` is available —
//      derive from addressLine1 instead so the two agree.
//
// This module is the single source of truth. Callers pass a patch,
// receive a sanitized copy plus a list of adjustments the caller can log.
// It is deliberately NON-THROWING; the DOP pipeline should never crash on
// a marginal record. Rejected fields are stripped from the patch.
//
// All target-DB writes are made via raw `mongoose.createConnection().collection()`
// calls, bypassing Mongoose model hooks. So the guard is invoked
// explicitly at each write site — not via a schema-level pre-save.

import { PLACEHOLDER_COVER_REGEX } from '../activation/seed-defaults';

// The four media fields that are known cover/logo carriers. If a caller
// invents a new one, it stays unguarded — that's fine; the placeholder
// only ever lands here in practice.
const MEDIA_FIELDS = [
  'cover',
  'coverThumbnail',
  'logo',
  'logoThumbnail',
] as const;

// Rejects addressLine1 that contains a phone number. Matches loose US
// 10-digit patterns (with and without formatting). Not a full E.164
// parser — it just catches the scraped-blob cases we see:
//   "1234 Main St (555) 123-4567"
//   "555-123-4567 Suite 200"
const PHONE_IN_ADDRESS_RE =
  /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/;

// Rejects addressLine1 with a URL fragment. `www.` alone is enough — a
// legitimate street name never contains it.
const URL_IN_ADDRESS_RE = /\b(?:https?:\/\/|www\.)\S+/i;

// Rejects addressLine1 that has scraper-artifact hours-text tokens.
// "Open · 9 AM–5 PM" / "Closed" / "Hours: ..." / bare "AM"/"PM" markers.
const HOURS_IN_ADDRESS_RE =
  /\b(?:Open(?:\s|·|,|$)|Closed(?:\s|·|,|$)|Hours\s*[:\-]|[0-9](?:\s?[AP]M)|Permanently\s+closed)\b/i;

// Postal anchor: the last comma-segment of a well-formed US address
// must look like "XX 12345" or "XX 12345-1234". Shared with the
// existing pipeline resync logic so a single change updates both.
export const STATE_ZIP_RE = /^[A-Za-z]{2}\s+\d{5}(-\d{4})?$/;

// Matches a state+ZIP fragment ANYWHERE in the string (with the same
// two-letter + 5-digit shape). Used to detect leftover full-formatted
// addresses in what should be a street-only addressLine1.
const STATE_ZIP_ANYWHERE_RE = /\b[A-Za-z]{2}\s+\d{5}(?:-\d{4})?\b/;

// Matches the ", USA" / ", United States[ of America]" country suffix.
const US_COUNTRY_SUFFIX_RE =
  /,\s*(USA|United States(?: of America)?)\s*$/i;

// Detects a street-type token (case-insensitive, word-boundaried) or
// "Broadway"/"Boulevard"-style anchors. A street line either starts
// with a digit (house number) OR contains one of these tokens. Named
// landmarks with neither (e.g. "The Metropolitan Opera House") fall out
// — c5 will flag those and they need a separate resolve pass.
const STREET_TOKEN_RE =
  /\b(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Hwy|Highway|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Sq|Square|Broadway|Turnpike|Tpke|Trail|Trl|Loop|Alley|Aly|Row|Walk|Plaza|Plz|Crossing|Xing)\b/i;

// True when `s` looks like a street line (no state+ZIP, no US suffix,
// starts with digit OR carries a street-type token). Shared by
// isValidAddressLine1 (write-time) and c5_valid_address (read-time)
// so both surfaces enforce the same shape.
export function isStreetLineShape(s: string | null | undefined): boolean {
  const v = (s ?? '').toString().trim();
  if (!v) return false;
  const withoutCountry = v.replace(US_COUNTRY_SUFFIX_RE, '').trim();
  if (!withoutCountry) return false;
  if (STATE_ZIP_ANYWHERE_RE.test(withoutCountry)) return false;
  if (/\b(?:USA|United States)\b/i.test(withoutCountry)) return false;
  if (/^\d/.test(withoutCountry)) return true;
  return STREET_TOKEN_RE.test(withoutCountry);
}

export interface DeriveCityResult {
  derivedCity: string | null;
  ambiguousReason?:
    | 'empty_addressLine1'
    | 'fewer_than_2_segments'
    | 'no_state_zip_segment'
    | 'empty_derived'
    | 'numeric_derived';
}

// Derives a city from a comma-delimited postal-shaped addressLine1 by
// stripping trailing country and picking the segment immediately before
// the state+ZIP anchor. Returns null (with an ambiguousReason) when the
// input is malformed. Mirrors the private helper on
// SeedingPipelineService — kept aligned intentionally.
export function deriveCityFromAddressLine1(
  addressLine1: string | null | undefined,
): DeriveCityResult {
  const raw = (addressLine1 ?? '').toString().trim();
  if (!raw) {
    return { derivedCity: null, ambiguousReason: 'empty_addressLine1' };
  }
  const withoutCountry = raw
    .replace(/,\s*(USA|United States(?: of America)?)\s*$/i, '')
    .trim();
  const parts = withoutCountry
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return { derivedCity: null, ambiguousReason: 'fewer_than_2_segments' };
  }
  const lastSegment = parts[parts.length - 1];
  if (!STATE_ZIP_RE.test(lastSegment)) {
    return { derivedCity: null, ambiguousReason: 'no_state_zip_segment' };
  }
  const candidate = parts[parts.length - 2].trim();
  if (!candidate) {
    return { derivedCity: null, ambiguousReason: 'empty_derived' };
  }
  if (/^\d+$/.test(candidate)) {
    return { derivedCity: null, ambiguousReason: 'numeric_derived' };
  }
  return { derivedCity: candidate };
}

// True when `s` is a valid street-only addressLine1: non-empty, no
// phone / URL / hours-text, no state+ZIP fragment, no country suffix,
// and either starts with a house number or carries a recognised
// street-type token. Post-item-5, addressLine1 stores ONLY the street
// portion — city / state / ZIP live on their own fields. The old
// postal-shape check (which required a trailing "XX 12345" segment) is
// replaced by isStreetLineShape.
export function isValidAddressLine1(s: string | null | undefined): boolean {
  const v = (s ?? '').toString().trim();
  if (!v) return false;
  if (PHONE_IN_ADDRESS_RE.test(v)) return false;
  if (URL_IN_ADDRESS_RE.test(v)) return false;
  if (HOURS_IN_ADDRESS_RE.test(v)) return false;
  return isStreetLineShape(v);
}

// Splits a Google formatted address into its four postal parts. The
// input is the full string ("123 Main St, Bronx, NY 10457, United
// States"); the output is `addressLine1` (the street line — everything
// before the city segment, rejoined with ", "), plus `city`,
// `stateCode`, `postalCode`. Returns null when the input doesn't end in
// a "XX 12345[-1234]" segment. NEVER guesses.
//
// The city segment is the second-to-last comma segment; the street
// portion is everything before it. Multi-segment street lines (e.g.
// "Haupt Conservatory, Bronx Park Rd") stay intact.
//
// Callers:
//   - resolve.service.ts: write-time, so incoming Google addresses land
//     in addressLine1 as the street line only.
//   - split_address_line backfill: retroactive fix for the 12k+ docs
//     that stored the full formatted string.
export interface SplitFormattedAddress {
  addressLine1: string;
  city: string;
  stateCode: string;
  postalCode: string;
}

export function splitFormattedAddress(
  full: string | null | undefined,
): SplitFormattedAddress | null {
  const raw = (full ?? '').toString().trim();
  if (!raw) return null;
  const withoutCountry = raw
    .replace(/,\s*(USA|United States(?: of America)?)\s*$/i, '')
    .trim();
  const parts = withoutCountry
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  const lastSegment = parts[parts.length - 1];
  const stateZipMatch = lastSegment.match(
    /^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/,
  );
  if (!stateZipMatch) return null;
  const stateCode = stateZipMatch[1].toUpperCase();
  const postalCode = stateZipMatch[2];
  const city = parts[parts.length - 2];
  if (!city) return null;
  const streetParts = parts.slice(0, parts.length - 2);
  const addressLine1 = streetParts.join(', ').trim();
  if (!addressLine1) return null;
  return { addressLine1, city, stateCode, postalCode };
}

export interface SanitizedBusinessPatch<T extends Record<string, any>> {
  patch: T;
  // Human-readable adjustments the caller can log. Empty when the patch
  // was already clean.
  adjustments: string[];
}

// Sanitizes an outgoing Business write patch in-place-safe (returns a new
// object; leaves the input alone). Applies:
//   - MEDIA_FIELDS containing a Defaults/* placeholder → dropped
//   - `addressLine1` that carries a full Google formatted address
//     (state+ZIP + optional country suffix) → auto-split into street
//     line + city + state + postalCode so legacy call sites (seed-
//     defaults, db-sync) that pre-date item 5 keep working.
//   - `addressLine1` failing isValidAddressLine1 (street-only shape) →
//     dropped (existing bad values on the doc stay; we just don't write
//     more).
//   - When auto-split fires: patch.city / patch.state / patch.postalCode
//     are set to the derived values only if the caller did not already
//     provide them. Explicit values from the caller win.
export function sanitizeBusinessPatch<T extends Record<string, any>>(
  input: T,
): SanitizedBusinessPatch<T> {
  const patch: Record<string, any> = { ...input };
  const adjustments: string[] = [];

  for (const f of MEDIA_FIELDS) {
    const v = patch[f];
    if (typeof v === 'string' && PLACEHOLDER_COVER_REGEX.test(v)) {
      delete patch[f];
      adjustments.push(`dropped ${f}: placeholder Defaults/* asset`);
    }
  }

  const incomingAddressLine1 = patch.addressLine1;
  if (typeof incomingAddressLine1 === 'string') {
    // Legacy full-formatted address slipping through — auto-split it.
    // Detection uses the anchor regex so an already-street-only value
    // (e.g. "4325 Park Ave") skips the split path unchanged.
    if (
      STATE_ZIP_ANYWHERE_RE.test(incomingAddressLine1) ||
      US_COUNTRY_SUFFIX_RE.test(incomingAddressLine1)
    ) {
      const split = splitFormattedAddress(incomingAddressLine1);
      if (split) {
        patch.addressLine1 = split.addressLine1;
        adjustments.push(
          `split addressLine1: "${incomingAddressLine1}" -> ` +
            `"${split.addressLine1}"`,
        );
        if (typeof patch.city !== 'string' || !patch.city) {
          patch.city = split.city;
        }
        if (typeof patch.state !== 'string' || !patch.state) {
          patch.state = split.stateCode;
        }
        if (typeof patch.postalCode !== 'string' || !patch.postalCode) {
          patch.postalCode = split.postalCode;
        }
      }
    }

    if (!isValidAddressLine1(patch.addressLine1)) {
      delete patch.addressLine1;
      adjustments.push(
        'dropped addressLine1: fails street-line shape / contains ' +
          'phone|URL|hours-text|state+ZIP',
      );
    }
  }

  return { patch: patch as T, adjustments };
}
