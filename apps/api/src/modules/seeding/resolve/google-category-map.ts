// Source-of-truth map: raw Google Maps / Overture category strings →
// PinnTag taxonomy (industry + categories[]). ObjectId hex strings here
// are validated against the staging taxonomy docs cited in the brief.
//
// Keys come in two shapes depending on the caller:
//   - Google Maps: space-separated ("nail salon", "beauty salon")
//   - Overture:    underscore-separated ("real_estate_agent", "beauty_salon")
// Both live in the same map. lookupGoogleCategory() normalises case +
// whitespace but does NOT swap underscores for spaces, so pipelines that
// pass through Overture's raw category strings need the underscore variant
// registered explicitly.
//
// Industry IDs (staging pinntagStaging.businessindustries):
//   Beauty & Wellness   696d140dae182db75cb6cbda
//   Local Services      696d1413ae182db75cb6cbe5
//   Retail & Shopping   696d1407ae182db75cb6cbcf
//   Food & Drink        696d13f2ae182db75cb6cbac
//
// Resolve writes use these IDs verbatim. Keep this file the ONLY place
// that hardcodes taxonomy ids — the resolve service + data-repair
// taxonomy tab both read from here so we never drift.
//
// Adding a new mapping: add a key (lowercased raw category string) to
// GOOGLE_CATEGORY_MAP. Lookups in lookupGoogleCategory normalise case +
// whitespace before matching, so the keys stay tidy.

export const BEAUTY_WELLNESS_INDUSTRY_ID = '696d140dae182db75cb6cbda';
export const LOCAL_SERVICES_INDUSTRY_ID = '696d1413ae182db75cb6cbe5';
export const RETAIL_SHOPPING_INDUSTRY_ID = '696d1407ae182db75cb6cbcf';
export const FOOD_DRINK_INDUSTRY_ID = '696d13f2ae182db75cb6cbac';

export const BEAUTY_WELLNESS_CATEGORY_IDS = {
  nail: '6a01d2c166dc77f8231f9fa6',
  spaMassage: '696d140fae182db75cb6cbdb',
  hair: '6a01d2c266dc77f8231f9fa9',
  beauty: '696d1410ae182db75cb6cbdd',
  medSpa: '6a01d2c266dc77f8231f9fac',
  wellness: '696d1412ae182db75cb6cbe3',
} as const;

export const LOCAL_SERVICES_CATEGORY_IDS = {
  businessProfessional: '6a74beac8adf8bb1675488db',
} as const;

export const RETAIL_SHOPPING_CATEGORY_IDS = {
  grocery: '696d140cae182db75cb6cbd6',
  specialty: '696d140bae182db75cb6cbd4',
} as const;

export const FOOD_DRINK_CATEGORY_IDS = {
  restaurant: '696d13f5ae182db75cb6cbad',
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

  // Overture underscore-form keys. Added after the run_1786732987891
  // needsReview analysis: the category-judge LLM was consistently
  // fitting these into the taxonomy but never clearing the 0.9 gate
  // (Ollama flat-emits ~0.8 as its "moderately confident" default). Each
  // mapping below is the LLM's own modal industry+category pick for that
  // overtureCategory in that run's calibration bucket — same taxonomy
  // choice, elevated to rule-tier so it lands at confidence 1.0 with no
  // LLM call and no per-run noise.
  'real_estate_agent': {
    industryId: LOCAL_SERVICES_INDUSTRY_ID,
    categoryIds: [LOCAL_SERVICES_CATEGORY_IDS.businessProfessional],
    proposedLabel: 'Local Services → Business & Professional',
  },
  'professional_services': {
    industryId: LOCAL_SERVICES_INDUSTRY_ID,
    categoryIds: [LOCAL_SERVICES_CATEGORY_IDS.businessProfessional],
    proposedLabel: 'Local Services → Business & Professional',
  },
  'gas_station': {
    industryId: RETAIL_SHOPPING_INDUSTRY_ID,
    categoryIds: [RETAIL_SHOPPING_CATEGORY_IDS.grocery],
    proposedLabel: 'Retail & Shopping → Grocery / Market',
  },
  'atms': {
    industryId: RETAIL_SHOPPING_INDUSTRY_ID,
    categoryIds: [RETAIL_SHOPPING_CATEGORY_IDS.specialty],
    proposedLabel: 'Retail & Shopping → Specialty / Boutique',
  },
  'beauty_salon': {
    industryId: BEAUTY_WELLNESS_INDUSTRY_ID,
    categoryIds: [BEAUTY_WELLNESS_CATEGORY_IDS.beauty],
    proposedLabel: 'Beauty & Wellness → Beauty',
  },
  'counseling_and_mental_health': {
    industryId: BEAUTY_WELLNESS_INDUSTRY_ID,
    categoryIds: [BEAUTY_WELLNESS_CATEGORY_IDS.wellness],
    proposedLabel: 'Beauty & Wellness → Wellness',
  },
  'restaurant': {
    industryId: FOOD_DRINK_INDUSTRY_ID,
    categoryIds: [FOOD_DRINK_CATEGORY_IDS.restaurant],
    proposedLabel: 'Food & Drink → Restaurant',
  },
  'doctor': {
    industryId: BEAUTY_WELLNESS_INDUSTRY_ID,
    categoryIds: [BEAUTY_WELLNESS_CATEGORY_IDS.wellness],
    proposedLabel: 'Beauty & Wellness → Wellness',
  },
  'pharmacy': {
    industryId: RETAIL_SHOPPING_INDUSTRY_ID,
    categoryIds: [RETAIL_SHOPPING_CATEGORY_IDS.grocery],
    proposedLabel: 'Retail & Shopping → Grocery / Market',
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
