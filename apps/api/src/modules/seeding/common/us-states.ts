// Shared US state name converter for any code path that writes a state
// value into a target PinnTag DB.
//
// Internal callers (resolvers, validators, the seed list) keep working in
// 2-letter abbreviations because they're reliable for comparison. At the
// moment of writing to a target DB, however, we always store the full
// title-case name ("Georgia", "North Carolina"). `fullStateName` is the
// single boundary point — it accepts either form and is idempotent, so it
// is safe to call on a value that has already been converted.

export const ABBREV_TO_STATE: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

// Reverse map for accepting full-name input (idempotency).
const NAME_TO_ABBREV: Record<string, string> = {};
for (const [abbrev, name] of Object.entries(ABBREV_TO_STATE)) {
  NAME_TO_ABBREV[name.toLowerCase()] = abbrev;
}

/**
 * Convert a state value to its title-case full name for storage in a
 * target DB. Idempotent: a value that is already a full name comes
 * back unchanged. A value we cannot resolve (e.g. empty string, foreign
 * state, free-text garbage) is returned untouched so that we never
 * silently blank a field.
 */
export function fullStateName(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';

  // 2-letter abbreviation
  if (trimmed.length === 2) {
    const up = trimmed.toUpperCase();
    if (ABBREV_TO_STATE[up]) return ABBREV_TO_STATE[up];
    return trimmed;
  }

  // Already a full name (case-insensitive)
  const lc = trimmed.toLowerCase();
  if (NAME_TO_ABBREV[lc]) {
    // Return the canonical title-case spelling, not whatever casing was passed in.
    return ABBREV_TO_STATE[NAME_TO_ABBREV[lc]];
  }

  // Not a US state — pass through unchanged.
  return trimmed;
}
