// Confidence gate for "is the place Google returned the same business we
// asked about?". Used by ResolveService BEFORE writing placeId or hours.
//
// Rule priority (first match wins; result records which rule fired):
//   (1) equal          — normalized names are identical
//   (2) contains       — one normalized name fully contains the other
//   (3) equal_suffixed — equal after stripping a common trailing suffix
//                        ("Cooper's Hawk Winery" ≡ "Cooper's Hawk")
//   (4) overlap        — |A ∩ B| / min(|A|, |B|) >= 0.6, where the
//                        intersection is more than one generic token
//   (5) jaccard        — kept as a fallback for the historical Jaccard
//                        rule (union-based) at ≥ 0.6
//
// A failed gate flips the business to resolveStatus.status='review'
// with reason 'name_mismatch'. No placeId or hours are ever written
// when this returns false.

const PUNCT_RE = /[\p{P}\p{S}]+/gu;

// Stopwords stripped from tokenization so "The Works" and "Works" hash
// the same. Keep this small — dropping too aggressively risks false
// accepts ("The Bar" vs "The Cafe" if we drop "The" AND both descriptors
// resolve to generic).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'co', 'inc', 'llc', 'ltd',
  'limited', 'corp', 'corporation', 'company',
]);

// Common trailing category words a business gets on Google but not
// in our stored name (and vice versa). Stripping these lets
// "Cooper's Hawk" match "Cooper's Hawk Winery & Restaurant".
const COMMON_SUFFIXES = new Set([
  'restaurant', 'cafe', 'coffee', 'bar', 'grill', 'salon', 'spa',
  'studio', 'gallery', 'shop', 'store', 'boutique', 'inc', 'llc',
  'co', 'company', 'winery', 'brewery', 'distillery', 'kitchen',
  'lounge', 'club', 'center', 'centre', 'hotel', 'inn', 'motel',
  'pub', 'tavern', 'bakery', 'diner', 'bistro', 'eatery', 'market',
  'shoppe', 'academy', 'llp',
]);

// Generic tokens that must NOT be the sole basis for an overlap
// accept. A single-token intersection made up of one of these is
// almost always coincidence ("Keratin Cafe" vs "Hair Cafe").
const GENERIC_TOKENS = new Set([
  'the', 'a', 'an', 'of', 'and',
  'cafe', 'bar', 'grill', 'salon', 'spa', 'studio', 'gallery',
  'shop', 'store', 'restaurant', 'kitchen', 'lounge', 'club',
  'hair', 'beauty', 'nail', 'nails', 'hotel', 'inn', 'boutique',
  'coffee', 'tea', 'food', 'bistro', 'academy',
  // U.S. city / state fragments seen in the false-accept examples
  'atlanta', 'nyc', 'ny', 'la', 'sf', 'boston', 'miami', 'brooklyn',
  'manhattan',
]);

/** Strip combining diacritics ("ZBeauté" → "ZBeaute"). */
function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function normalizeName(value: string | undefined | null): string {
  if (!value) return '';
  const spaced = stripDiacritics(value.toLowerCase())
    // "&" → " and " before punctuation strip so it survives.
    .replace(/&/g, ' and ')
    .replace(PUNCT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Glue runs of single-letter tokens ("m a d beauty" → "mad beauty")
  // so acronyms written with dots ("M.A.D.") collapse onto the joined
  // form Google surfaces ("Mad Beauty Bar").
  return spaced.replace(
    /\b[a-z](?:\s[a-z])+\b/g,
    (m) => m.replace(/\s+/g, ''),
  );
}

/** Basic singular collapse — treat "nails" / "nail" as one token. */
function stemPlural(token: string): string {
  if (token.length > 3 && token.endsWith('ies')) {
    return token.slice(0, -3) + 'y';
  }
  if (
    token.length > 3 &&
    token.endsWith('s') &&
    !token.endsWith('ss') &&
    !token.endsWith('us')
  ) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(value: string): string[] {
  const norm = normalizeName(value);
  if (!norm) return [];
  return norm
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stemPlural);
}

function tokenSet(value: string): Set<string> {
  return new Set(tokenize(value));
}

/** Strip a trailing city (case-insensitive) from the tail of the
 *  normalized string. Used for names like "The Works Upper Westside" +
 *  city "Atlanta" → strip "atlanta" from "the works upper westside atlanta". */
function stripTrailingCity(
  norm: string,
  city: string | null | undefined,
): string {
  const c = normalizeName(city ?? '');
  if (!c) return norm;
  const suffix = ' ' + c;
  if (norm.endsWith(suffix)) return norm.slice(0, -suffix.length).trim();
  if (norm === c) return '';
  return norm;
}

/** Drop trailing common-suffix tokens ("cooper s hawk winery" → "cooper s hawk"). */
function stripTrailingSuffixes(tokens: string[]): string[] {
  const out = tokens.slice();
  while (out.length > 1 && COMMON_SUFFIXES.has(out[out.length - 1])) {
    out.pop();
  }
  return out;
}

function overlapOverSmaller(a: Set<string>, b: Set<string>): {
  score: number;
  interSize: number;
  interSole: string | null;
} {
  if (a.size === 0 || b.size === 0) {
    return { score: 0, interSize: 0, interSole: null };
  }
  let inter = 0;
  let sole: string | null = null;
  for (const t of a) {
    if (b.has(t)) {
      inter += 1;
      sole = t;
    }
  }
  const denom = Math.min(a.size, b.size);
  return {
    score: denom === 0 ? 0 : inter / denom,
    interSize: inter,
    interSole: inter === 1 ? sole : null,
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface NameConfidence {
  match: boolean;
  rule:
    | 'equal'
    | 'contains'
    | 'equal_suffixed'
    | 'overlap'
    | 'jaccard'
    | 'no_match';
  score: number;
  normalizedStored: string;
  normalizedResolved: string;
}

/**
 * Compare a stored business name to the name Google returned for the
 * resolved place. `city` is optional — when provided, a trailing city
 * name on either side is stripped before comparison so
 * "The Works Upper Westside" ≡ "The Works Upper Westside Atlanta".
 */
export function compareNames(
  storedName: string | undefined | null,
  resolvedName: string | undefined | null,
  city?: string | null,
): NameConfidence {
  const rawA = normalizeName(storedName);
  const rawB = normalizeName(resolvedName);

  // Strip trailing city (if given) from both sides.
  const a = stripTrailingCity(rawA, city);
  const b = stripTrailingCity(rawB, city);

  const base = {
    normalizedStored: a || rawA,
    normalizedResolved: b || rawB,
  };

  if (!a || !b) {
    return { match: false, rule: 'no_match', score: 0, ...base };
  }
  if (a === b) {
    return { match: true, rule: 'equal', score: 1, ...base };
  }
  if (a.includes(b) || b.includes(a)) {
    return { match: true, rule: 'contains', score: 1, ...base };
  }

  const toksA = tokenize(a);
  const toksB = tokenize(b);

  // Suffix-strip equality: "cooper s hawk winery" ≡ "cooper s hawk"
  // once trailing category words come off. Requires EQUAL stripped
  // strings (not contains) and ≥ 2 tokens on each side — otherwise
  // "Ellie Grills" collapses to "ellie" and false-matches
  // "Eats by Ellie".
  const stripAToks = stripTrailingSuffixes(toksA);
  const stripBToks = stripTrailingSuffixes(toksB);
  const stripA = stripAToks.join(' ');
  const stripB = stripBToks.join(' ');
  if (
    stripAToks.length >= 2 &&
    stripBToks.length >= 2 &&
    stripA === stripB
  ) {
    return { match: true, rule: 'equal_suffixed', score: 0.95, ...base };
  }
  // Asymmetric strip: "KR Nails" (2 tokens, no suffixes) vs "KR Nail
  // studio academy" (4 tokens, 2 suffixes) → keep as equal_suffixed
  // when the unstripped side EQUALS the stripped-longer side.
  if (
    stripAToks.length >= 2 &&
    stripBToks.length >= 2 &&
    (toksA.join(' ') === stripB || toksB.join(' ') === stripA)
  ) {
    return { match: true, rule: 'equal_suffixed', score: 0.9, ...base };
  }

  const setA = new Set(toksA);
  const setB = new Set(toksB);

  // Overlap over the SMALLER set (spec §FIX 2). Guarded:
  //  1) single-generic-token overlap ("cafe", "beauty", "the")
  //     is coincidence — reject.
  //  2) min(|A|, |B|) < 2 makes the ratio trivially 0 or 1 — reject.
  //  3) intersection must contain ≥ 2 NON-generic tokens ("tiny" ∩
  //     {"tiny","toon","gift","gallery"} = one non-generic + one
  //     generic; not enough signal to be the same business).
  const ov = overlapOverSmaller(setA, setB);
  let nonGenericInter = 0;
  for (const t of setA) if (setB.has(t) && !GENERIC_TOKENS.has(t)) nonGenericInter += 1;
  if (
    ov.score >= 0.6 &&
    Math.min(setA.size, setB.size) >= 2 &&
    nonGenericInter >= 2 &&
    !(ov.interSize === 1 && ov.interSole && GENERIC_TOKENS.has(ov.interSole))
  ) {
    return { match: true, rule: 'overlap', score: ov.score, ...base };
  }

  // Fallback: keep the historical Jaccard rule so the loosening is
  // monotonic (nothing that previously passed now fails).
  const jac = jaccard(setA, setB);
  if (jac >= 0.6) {
    return { match: true, rule: 'jaccard', score: jac, ...base };
  }

  return {
    match: false,
    rule: 'no_match',
    score: Math.max(ov.score, jac),
    ...base,
  };
}

/**
 * A placeId is "valid" for resolve purposes when it follows Google's
 * ChIJ encoding. Anything else (legacy GhIJ, or non-Place identifiers)
 * is treated as unusable.
 */
export function isValidChIJPlaceId(value: unknown): value is string {
  return typeof value === 'string' && /^ChIJ[A-Za-z0-9_-]+$/.test(value);
}
