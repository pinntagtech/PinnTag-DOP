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

// True when `s` is a well-formed street-line: non-empty, no phone,
// no URL, no hours-text, and postal-shaped (comma-delimited with a
// trailing "ST 12345" segment). A trailing ", USA" / ", United States"
// suffix is stripped before the shape check — that's the dominant
// scraped format and it's still postal.
export function isValidAddressLine1(s: string | null | undefined): boolean {
  const v = (s ?? '').toString().trim();
  if (!v) return false;
  if (PHONE_IN_ADDRESS_RE.test(v)) return false;
  if (URL_IN_ADDRESS_RE.test(v)) return false;
  if (HOURS_IN_ADDRESS_RE.test(v)) return false;
  const withoutCountry = v
    .replace(/,\s*(USA|United States(?: of America)?)\s*$/i, '')
    .trim();
  const parts = withoutCountry
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return false;
  return STATE_ZIP_RE.test(parts[parts.length - 1]);
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
//   - `addressLine1` failing isValidAddressLine1 → dropped (existing
//     bad values on the doc stay; we just don't write more)
//   - When both `addressLine1` (new + valid) and `city` are present:
//     force `city` to the derived value. When only `city` is present,
//     leave it alone (explicit-city updates are honored).
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
    if (!isValidAddressLine1(incomingAddressLine1)) {
      delete patch.addressLine1;
      adjustments.push(
        'dropped addressLine1: fails postal shape / contains ' +
          'phone|URL|hours-text',
      );
    } else if (typeof patch.city === 'string' && patch.city.length > 0) {
      const { derivedCity } =
        deriveCityFromAddressLine1(incomingAddressLine1);
      if (
        derivedCity &&
        derivedCity.trim().toLowerCase() !==
          patch.city.trim().toLowerCase()
      ) {
        adjustments.push(
          `overrode city: "${patch.city}" -> "${derivedCity}" ` +
            '(derived from addressLine1)',
        );
        patch.city = derivedCity;
      }
    }
  }

  return { patch: patch as T, adjustments };
}
