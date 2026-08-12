// Helpers for Phase 1 dedup pass 1 (pre-filter). Deliberately in-process
// and tunable in one place — thresholds will be re-tuned off Atlanta pilot
// false-positive/negative counts, not guessed in advance.

const SUFFIX_TOKENS = new Set([
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'limited',
  'lp',
  'llp',
  'pllc',
  'pc',
  'pa',
]);

const STOP_TOKENS = new Set(['the', 'a', 'an', 'and', '&']);

// Lowercase, strip punctuation, drop legal suffixes + stop words, collapse
// whitespace. Two docs with the same normalized form will levenshtein to 1.0.
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return '';
  const lowered = String(raw).toLowerCase();
  const punctless = lowered.replace(/[^a-z0-9\s]/g, ' ');
  const tokens = punctless
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !SUFFIX_TOKENS.has(t) && !STOP_TOKENS.has(t));
  return tokens.join(' ').trim();
}

// Iterative two-row Levenshtein; O(n*m) time, O(min(n,m)) space. Small
// enough for Phase 1 candidate volumes without a native dep.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// 1.0 = identical, 0.0 = fully different. Both strings must be
// pre-normalized via normalizeName for the threshold to be meaningful.
export function nameSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// Great-circle distance in meters between two lat/lng pairs. Precision is
// meters-level — plenty for the 50m dedup radius.
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Degrees of latitude per meter is constant (~1/111320); degrees of
// longitude per meter varies by cos(lat). Bounding-box pre-filter for the
// haversine check — avoids O(N*M) haversine on every seeded-vs-candidate
// pair.
export function metersToLatDeg(m: number): number {
  return m / 111_320;
}

export function metersToLngDeg(m: number, atLat: number): number {
  const cos = Math.cos((atLat * Math.PI) / 180);
  if (cos < 1e-6) return m / 111_320; // near-pole degenerate; safe fallback
  return m / (111_320 * cos);
}
