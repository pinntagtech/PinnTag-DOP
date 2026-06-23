// Source-of-truth map: raw Google Maps category strings → PinnTag
// taxonomy (industry + categories[]). ObjectId hex strings here are
// validated against the staging taxonomy docs cited in the brief:
//
//   Industry "Beauty & Wellness"   696d140dae182db75cb6cbda
//
//   Categories under Beauty & Wellness:
//     Nail                          6a01d2c166dc77f8231f9fa6
//     Spa & Massage                 696d140fae182db75cb6cbdb
//     Hair                          6a01d2c266dc77f8231f9fa9
//     Beauty                        696d1410ae182db75cb6cbdd
//     Med spa                       6a01d2c266dc77f8231f9fac
//
// Resolve writes use these IDs verbatim. Keep this file the ONLY place
// that hardcodes taxonomy ids — the resolve service + data-repair
// taxonomy tab both read from here so we never drift.
//
// Adding a new mapping: add a key (lowercased Google string) to
// GOOGLE_CATEGORY_MAP. Lookups in lookupGoogleCategory normalise case +
// whitespace before matching, so the keys stay tidy.

export const BEAUTY_WELLNESS_INDUSTRY_ID = '696d140dae182db75cb6cbda';

export const BEAUTY_WELLNESS_CATEGORY_IDS = {
  nail: '6a01d2c166dc77f8231f9fa6',
  spaMassage: '696d140fae182db75cb6cbdb',
  hair: '6a01d2c266dc77f8231f9fa9',
  beauty: '696d1410ae182db75cb6cbdd',
  medSpa: '6a01d2c266dc77f8231f9fac',
} as const;

export interface GoogleCategoryMapping {
  industryId: string;
  categoryIds: string[];
  // Human-readable label for the proposed taxonomy — used by the
  // data-repair preview when we don't want to spend a DB round trip
  // to resolve titles. Operator-facing only; not stored.
  proposedLabel: string;
}

// Keys are Google's raw category string, normalised — lowercased,
// trimmed, internal whitespace collapsed. lookupGoogleCategory()
// applies the same normalisation before lookup.
const GOOGLE_CATEGORY_MAP: Record<string, GoogleCategoryMapping> = {
  'nail salon': {
    industryId: BEAUTY_WELLNESS_INDUSTRY_ID,
    categoryIds: [BEAUTY_WELLNESS_CATEGORY_IDS.nail],
    proposedLabel: 'Beauty & Wellness → Nail',
  },
  'spa': {
    industryId: BEAUTY_WELLNESS_INDUSTRY_ID,
    categoryIds: [BEAUTY_WELLNESS_CATEGORY_IDS.spaMassage],
    proposedLabel: 'Beauty & Wellness → Spa & Massage',
  },
  'day spa': {
    industryId: BEAUTY_WELLNESS_INDUSTRY_ID,
    categoryIds: [BEAUTY_WELLNESS_CATEGORY_IDS.spaMassage],
    proposedLabel: 'Beauty & Wellness → Spa & Massage',
  },
  'hair salon': {
    industryId: BEAUTY_WELLNESS_INDUSTRY_ID,
    categoryIds: [BEAUTY_WELLNESS_CATEGORY_IDS.hair],
    proposedLabel: 'Beauty & Wellness → Hair',
  },
  'barber': {
    industryId: BEAUTY_WELLNESS_INDUSTRY_ID,
    categoryIds: [BEAUTY_WELLNESS_CATEGORY_IDS.hair],
    proposedLabel: 'Beauty & Wellness → Hair',
  },
  'barber shop': {
    industryId: BEAUTY_WELLNESS_INDUSTRY_ID,
    categoryIds: [BEAUTY_WELLNESS_CATEGORY_IDS.hair],
    proposedLabel: 'Beauty & Wellness → Hair',
  },
  'beauty salon': {
    industryId: BEAUTY_WELLNESS_INDUSTRY_ID,
    categoryIds: [BEAUTY_WELLNESS_CATEGORY_IDS.beauty],
    proposedLabel: 'Beauty & Wellness → Beauty',
  },
  'medical spa': {
    industryId: BEAUTY_WELLNESS_INDUSTRY_ID,
    categoryIds: [BEAUTY_WELLNESS_CATEGORY_IDS.medSpa],
    proposedLabel: 'Beauty & Wellness → Med spa',
  },
  'med spa': {
    industryId: BEAUTY_WELLNESS_INDUSTRY_ID,
    categoryIds: [BEAUTY_WELLNESS_CATEGORY_IDS.medSpa],
    proposedLabel: 'Beauty & Wellness → Med spa',
  },
};

export function normalizeGoogleCategory(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function lookupGoogleCategory(
  raw: string | null | undefined,
): GoogleCategoryMapping | null {
  if (!raw || typeof raw !== 'string') return null;
  const key = normalizeGoogleCategory(raw);
  if (!key) return null;
  return GOOGLE_CATEGORY_MAP[key] ?? null;
}

// Stable sort + canonical string form of a list of ObjectId hexes, so
// equality checks between `current` and `proposed` are order-insensitive.
// Mongo stores categories as an array but order is meaningless for
// taxonomy comparison.
export function canonicalCategoryIds(
  ids: Array<string | { toString(): string } | null | undefined>,
): string {
  return ids
    .map((id) => (id == null ? '' : String(id)))
    .filter(Boolean)
    .sort()
    .join(',');
}
