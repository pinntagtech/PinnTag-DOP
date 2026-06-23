// Confidence gate for "is the place Google returned the same business we
// asked about?". Used by ResolveService BEFORE writing placeId or hours.
//
// Three accept conditions (in priority order):
//   (1) Normalised names are equal.
//   (2) One name fully contains the other (handles "Joe's Diner" vs
//       "Joe's Diner & Bar").
//   (3) Token Jaccard ≥ 0.6 — handles word-order differences and a
//       chain suffix on one side ("Starbucks Coffee" vs "Starbucks").
//
// A failed gate flips the business to resolveStatus.status='review'
// with reason 'name_mismatch'. No placeId or hours are ever written
// when this returns false.

const PUNCT_RE = /[\p{P}\p{S}]+/gu;
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', '&', 'co', 'inc', 'llc', 'ltd',
  'limited', 'corp', 'corporation', 'company',
]);

export function normalizeName(value: string | undefined | null): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(PUNCT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): Set<string> {
  const norm = normalizeName(value);
  if (!norm) return new Set();
  const tokens = norm
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t));
  return new Set(tokens);
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
  // 'equal' | 'contains' | 'jaccard' | 'no_match'
  rule: 'equal' | 'contains' | 'jaccard' | 'no_match';
  score: number;
  normalizedStored: string;
  normalizedResolved: string;
}

/**
 * Compare a stored business name to the name Google returned for the
 * resolved place. Returns `match: true` only when the gate is satisfied;
 * callers MUST refuse to write placeId/hours when this is false.
 */
export function compareNames(
  storedName: string | undefined | null,
  resolvedName: string | undefined | null,
): NameConfidence {
  const a = normalizeName(storedName);
  const b = normalizeName(resolvedName);

  const base = { normalizedStored: a, normalizedResolved: b };

  if (!a || !b) {
    return { match: false, rule: 'no_match', score: 0, ...base };
  }
  if (a === b) {
    return { match: true, rule: 'equal', score: 1, ...base };
  }
  if (a.includes(b) || b.includes(a)) {
    return { match: true, rule: 'contains', score: 1, ...base };
  }
  const overlap = jaccard(tokenize(a), tokenize(b));
  if (overlap >= 0.6) {
    return { match: true, rule: 'jaccard', score: overlap, ...base };
  }
  return { match: false, rule: 'no_match', score: overlap, ...base };
}

/**
 * A placeId is "valid" for resolve purposes when it follows Google's
 * ChIJ encoding. Anything else (legacy GhIJ, or non-Place identifiers)
 * is treated as unusable.
 */
export function isValidChIJPlaceId(value: unknown): value is string {
  return typeof value === 'string' && /^ChIJ[A-Za-z0-9_-]+$/.test(value);
}
