import { BusinessStatus } from '../../../common/enums';
import { OPEN_24H_DURATION } from '../resolve/hours-constants';

export interface ScraperRecord {
  place_name?: string;
  name?: string;
  address?: string;
  coordinates?: string;
  rating?: string | number;
  review_count?: string | number;
  phone?: string;
  website?: string;
  description?: string;
  about?: string;
  editorial_summary?: string;
  summary?: string;
  image?: string;
  photo?: string;
  image_url?: string;
  thumbnail?: string;
  place_images?: string | string[];
  url?: string;
  hours?: string;
  category?: string;
  prices?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  zip?: string;
  country?: string;
  addressLine1?: string;
  address1_line1?: string;
  [key: string]: any;
}

export type EmailMap =
  | Record<string, string | string[]>
  | Array<{
      url: string;
      email_count?: number;
      emails: string;
    }>;

export interface AdapterResult {
  records: any[];
  stats: {
    processed: number;
    noWebsite: number;
    emailMatched: number;
    emailUnmatched: number;
    categoryMapped: number;
    categoryFallback: number;
    cityResolved: number;
    cityDefaulted: number;
    cityUnresolved: number;
    areaInList: number;
    areaKeptCustom: number;
    // ── Stage B data-quality counters ──
    // Each counts records that tripped an import-validation flag below.
    // Surfaced in the import summary so the operator sees data quality
    // BEFORE running the pipeline. These are warnings, not failures.
    hoursUnparsed: number;
    addressInvalid: number;
    noCoords: number;
    noPlaceId: number;
    noName: number;
  };
}

// ─── US State validator ─────────────────────────────────────────────────
// Maps both 2-letter codes and full state names to canonical 2-letter codes.
// Used to (a) recognise whether a parsed value is a valid US state and
// (b) normalise full names ("New York") to abbreviations ("NY").

const US_STATE_ABBR_TO_NAME: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas',
  CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
  IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming',
};

const US_STATE_NAME_TO_ABBR: Record<string, string> = {};
for (const [abbr, name] of Object.entries(US_STATE_ABBR_TO_NAME)) {
  US_STATE_NAME_TO_ABBR[name.toLowerCase()] = abbr;
}

function normalizeUsState(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  // 2-letter code
  if (t.length === 2) {
    const up = t.toUpperCase();
    if (US_STATE_ABBR_TO_NAME[up]) return up;
    return null;
  }
  // Full name
  const lc = t.toLowerCase();
  if (US_STATE_NAME_TO_ABBR[lc]) return US_STATE_NAME_TO_ABBR[lc];
  return null;
}

export interface AdapterLocationArea {
  name: string;
  subRegion?: string;
  state?: string;
}

export interface AdapterLocationCity {
  city: string;
  state: string;
  areas?: AdapterLocationArea[];
  isActive?: boolean;
}

interface CityIndexEntry {
  city: string;
  state: string;
  areasByKey: Map<string, AdapterLocationArea>;
}

interface LocationIndex {
  citiesByKey: Map<string, CityIndexEntry>;
  // area name (lowercased) -> list of cities that contain it
  areaToCities: Map<string, CityIndexEntry[]>;
}

function buildLocationIndex(
  locations: AdapterLocationCity[] | undefined,
): LocationIndex {
  const citiesByKey = new Map<string, CityIndexEntry>();
  const areaToCities = new Map<string, CityIndexEntry[]>();

  for (const loc of locations ?? []) {
    if (loc.isActive === false) continue;
    if (!loc.city) continue;
    const entry: CityIndexEntry = {
      city: loc.city,
      state: loc.state,
      areasByKey: new Map(),
    };
    for (const area of loc.areas ?? []) {
      if (!area?.name) continue;
      const key = area.name.toLowerCase();
      entry.areasByKey.set(key, area);
      const arr = areaToCities.get(key) ?? [];
      arr.push(entry);
      areaToCities.set(key, arr);
    }
    citiesByKey.set(loc.city.toLowerCase(), entry);
  }

  return { citiesByKey, areaToCities };
}

function findAreaInText(
  text: string,
  candidates: Iterable<string>,
): string | null {
  if (!text) return null;
  const haystack = text.toLowerCase();
  for (const key of candidates) {
    if (!key) continue;
    // Word-boundary-ish: surround text in spaces so single-word
    // matches like "soho" don't false-positive on "absoho..."
    if (haystack.includes(key)) return key;
  }
  return null;
}

function extractPlaceId(url: string): string | null {
  if (!url) return null;

  const match19s = url.match(/!19s([^?&\/]+)/);
  if (match19s) return match19s[1];

  const matchCid = url.match(/!1s0x[0-9a-f]+:0x([0-9a-f]+)/i);
  if (matchCid) return `0x${matchCid[1]}`;

  return null;
}

// Parse the raw phone into its national digits plus, when present, the
// "+NN" country-code prefix. We do NOT default the country code here — an
// absent prefix returns hadPrefix:false so the caller can infer it from
// coords/country instead of blindly stamping "+1".
function parsePhone(raw: string): {
  countryCode: string;
  phone: string;
  hadPrefix: boolean;
} {
  if (!raw || !raw.trim()) {
    return { countryCode: '', phone: '', hadPrefix: false };
  }

  const trimmed = raw.trim();

  let countryCode = '';
  let hadPrefix = false;
  let digits = trimmed;

  // Require a separator after the prefix so "+1 802…" yields "+1" (not
  // "+1 8…") and a glued local number like "8023475362" isn't misread.
  const ccMatch = trimmed.match(/^(\+\d{1,3})[\s\-.]/);
  if (ccMatch) {
    countryCode = ccMatch[1];
    hadPrefix = true;
    digits = trimmed.slice(ccMatch[0].length);
  }

  const phone = digits.replace(/\D/g, '');

  return { countryCode, phone, hadPrefix };
}

// Calling codes for the handful of countries the scraper has actually
// produced. Used only when the raw phone has no "+NN" prefix but the
// country field names a country — we still avoid stamping "+1" blindly.
const COUNTRY_TO_CALLING_CODE: Record<string, string> = {
  'united states': '+1',
  'united states of america': '+1',
  usa: '+1',
  canada: '+1',
  india: '+91',
  'united kingdom': '+44',
  uk: '+44',
  australia: '+61',
  mexico: '+52',
};

// Resolve the country code without blindly defaulting to "+1":
//   1. an explicit "+NN" prefix on the raw phone always wins;
//   2. else infer "+1" from a US signal (US coords / "United States" / a
//      valid US state);
//   3. else map a named non-US country to its calling code;
//   4. else, if coords are set but non-US, leave blank and FLAG it;
//   5. else (no signal at all) fall back to "+1" — the dataset is US-centric
//      and nothing contradicts it. The key is always present either way.
function resolveCountryCode(args: {
  hadPrefix: boolean;
  prefix: string;
  country: string;
  state: string;
  latitude: number;
  longitude: number;
  warnings: string[];
}): string {
  const { hadPrefix, prefix, country, state, latitude, longitude, warnings } =
    args;

  if (hadPrefix && prefix) return prefix;

  const coordsSet = latitude !== 0 || longitude !== 0;
  const usByCoord = coordsSet && isUsCoord(latitude, longitude);
  const countryKey = (country || '').trim().toLowerCase();
  const usByCountry =
    countryKey === 'united states' ||
    countryKey === 'united states of america' ||
    countryKey === 'usa';
  const usByState = !!normalizeUsState(state);

  if (usByCoord || usByCountry || usByState) return '+1';

  if (countryKey && COUNTRY_TO_CALLING_CODE[countryKey]) {
    return COUNTRY_TO_CALLING_CODE[countryKey];
  }

  if (coordsSet && !usByCoord) {
    warnings.push(
      '[stage-b] countryCode could not be inferred — phone has no "+NN" ' +
        `prefix and coordinates (${latitude}, ${longitude}) are non-US`,
    );
    return '';
  }

  return '+1';
}

function parseCoordinates(raw: string): {
  latitude: number;
  longitude: number;
} | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 2) return null;
  const lat = parseFloat(parts[0]);
  const lng = parseFloat(parts[1]);
  if (isNaN(lat) || isNaN(lng)) return null;
  return { latitude: lat, longitude: lng };
}

function parseRating(raw: string | number): number {
  if (typeof raw === 'number') return raw;
  const parsed = parseFloat(raw);
  return isNaN(parsed) ? 0 : parsed;
}

function parseReviewCount(raw: string | number): number {
  if (typeof raw === 'number') return raw;
  if (!raw) return 0;
  const cleaned = String(raw).replace(/,/g, '');
  const parsed = parseInt(cleaned, 10);
  return isNaN(parsed) ? 0 : parsed;
}

const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

// ─── Hours parser ──────────────────────────────────────────────────────────
//
// Google's scraped hours arrive as ONE glued string with all seven days
// concatenated directly onto their time text and footer/advisory UI mixed
// in, e.g.
//   "Tuesday8 am–8 pmWednesday8 am–8 pm…Friday(Juneteenth)8 am–8 pm Hours
//    might differSaturday8 am–8 pm…Monday8 am–8 pmSuggest new hours"
// The old spaced-only regex matched none of this, so every business imported
// all-closed. We split on day-name boundaries, strip the noise, then parse
// each day's time text (single range, split-shift envelope, 24h, closed,
// meridiem-inherit, overnight).

type HoursDuration = {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
};
type HoursDay = { duration: HoursDuration | null; isClosed: boolean };

// "Open 24 hours" → 0:00–23:59 (LOCKED, shared with the resolve hours-parser
// via hours-constants so the two never diverge).

// Day-name boundary — used both to split the blob and to read each
// segment's leading day label.
const DAY_NAME_RE =
  /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/i;
const DAY_NAME_GLOBAL_RE = new RegExp(DAY_NAME_RE.source, 'gi');

// Footer / advisory / holiday noise that the scraper glues onto a day's
// time text. Stripped before parsing. "(…)" covers "(Juneteenth)" and any
// other parenthetical holiday note. No \b anchors — these arrive fused to
// the preceding time ("8 pmSuggest new hours"), so a leading word boundary
// would never match; they're whole multi-word phrases, so a plain substring
// strip is safe.
const HOURS_NOISE_RE =
  /\([^)]*\)|hours might (?:differ|vary)|holiday hours|suggest new hours|copy open hours/gi;

// One clock token: "8", "8:30", "8 am", "8:30 pm", "noon", "midnight".
// Returns the raw 12-hour value + minute + meridiem (null when omitted) so
// the caller can apply meridiem inheritance before normalising to 24h.
function parseClockToken(
  tok: string,
): { raw12: number; minute: number; meridiem: 'am' | 'pm' | null } | null {
  const t = tok.trim().toLowerCase();
  if (!t) return null;
  if (t === 'noon') return { raw12: 12, minute: 0, meridiem: 'pm' };
  if (t === 'midnight') return { raw12: 12, minute: 0, meridiem: 'am' };

  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  const raw12 = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = (m[3] as 'am' | 'pm' | undefined) ?? null;
  if (raw12 < 0 || raw12 > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return { raw12, minute, meridiem };
}

// Apply a meridiem to a raw 12-hour value → 24-hour. "12 am" → 0, "12 pm"
// → 12, "1 pm" → 13.
function to24(raw12: number, meridiem: 'am' | 'pm'): number {
  if (meridiem === 'pm' && raw12 !== 12) return raw12 + 12;
  if (meridiem === 'am' && raw12 === 12) return 0;
  return raw12;
}

// Parse ONE "start-end" range to a 24-hour duration. The end token must
// carry a meridiem (it's the anchor). When the start omits its meridiem we
// inherit the end's; if that makes start>end on the same day (e.g.
// "11–2 pm" → 23:00–14:00) we flip the start to am ("11 am–2 pm"). Overnight
// ranges where the end legitimately carries its own earlier meridiem
// ("11 am–2 am") are kept as end<start — the consumer wraps them.
function parseHoursRange(
  rawStart: string,
  rawEnd: string,
): HoursDuration | null {
  const start = parseClockToken(rawStart);
  const end = parseClockToken(rawEnd);
  if (!start || !end || !end.meridiem) return null;

  const endHour = to24(end.raw12, end.meridiem);
  const endMinute = end.minute;

  let startHour: number;
  if (start.meridiem) {
    startHour = to24(start.raw12, start.meridiem);
  } else {
    const inherited = to24(start.raw12, end.meridiem);
    const inheritedMin = inherited * 60 + start.minute;
    const endMin = endHour * 60 + endMinute;
    startHour =
      inheritedMin > endMin ? to24(start.raw12, 'am') : inherited;
  }
  const startMinute = start.minute;

  // Zero-length same-clock range ("12 pm–12 pm") is ambiguous — skip.
  if (startHour === endHour && startMinute === endMinute) return null;

  return { startHour, startMinute, endHour, endMinute };
}

// One TIME-TIME range fragment; scanned globally to collect split shifts.
const HOURS_TIME_FRAG = String.raw`(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)`;
const HOURS_RANGE_RE = new RegExp(
  `(${HOURS_TIME_FRAG})\\s*-\\s*(${HOURS_TIME_FRAG})`,
  'gi',
);

// Parse a single day's time text (post day-label, post-split) into a
// HoursDay, or null when it can't be parsed (caller leaves the day Closed).
function parseDayValue(rawValue: string): HoursDay | null {
  let v = rawValue
    .replace(HOURS_NOISE_RE, ' ')
    .replace(/[–—‒−]/g, '-') // en/em/figure dash, minus → '-'
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!v) return null;
  if (v === 'closed') return { duration: null, isClosed: true };
  if (/open 24 hours|^24 hours$|^open 24$/.test(v)) {
    return { duration: { ...OPEN_24H_DURATION }, isClosed: false };
  }

  // Un-glue a meridiem fused to the next range's start digit
  // ("1 pm5–8:30 pm" → "1 pm 5–8:30 pm") so split shifts tokenise cleanly.
  v = v.replace(/(am|pm)(?=\d)/g, '$1 ');

  const ranges: HoursDuration[] = [];
  HOURS_RANGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HOURS_RANGE_RE.exec(v)) !== null) {
    const range = parseHoursRange(m[1], m[2]);
    if (range) ranges.push(range);
  }
  if (ranges.length === 0) return null;
  if (ranges.length === 1) return { duration: ranges[0], isClosed: false };

  // Split shift — the schema stores ONE duration per day, so collapse the
  // N ranges to a single envelope: earliest start → latest end.
  let earliest = ranges[0];
  let latest = ranges[0];
  for (const r of ranges) {
    if (r.startHour * 60 + r.startMinute < earliest.startHour * 60 + earliest.startMinute) {
      earliest = r;
    }
    if (r.endHour * 60 + r.endMinute > latest.endHour * 60 + latest.endMinute) {
      latest = r;
    }
  }
  return {
    duration: {
      startHour: earliest.startHour,
      startMinute: earliest.startMinute,
      endHour: latest.endHour,
      endMinute: latest.endMinute,
    },
    isClosed: false,
  };
}

// Split the glued blob into { day, value } segments. Each day's segment is
// everything from its name until the next day name.
function splitGluedHours(raw: string): { day: string; value: string }[] {
  // Scan for every day-name occurrence; each day's value runs from the end
  // of its name to the start of the next day name (or end of string). Index
  // based so we never split on the spaces inside a time value ("8 am-8 pm").
  const re = new RegExp(DAY_NAME_GLOBAL_RE.source, 'gi');
  const hits: { day: string; start: number; nameStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    hits.push({
      day: m[1].toLowerCase(),
      nameStart: m.index,
      start: m.index + m[1].length,
    });
  }
  const out: { day: string; value: string }[] = [];
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].nameStart : raw.length;
    out.push({ day: hits[i].day, value: raw.slice(hits[i].start, end) });
  }
  return out;
}

export function parseHours(raw: string): { weekDays: Record<string, HoursDay> } {
  // Real PinnTag DaySchedule shape:
  //   open:   { duration: {startHour,startMinute,endHour,endMinute}, isClosed: false }
  //   closed: { duration: null, isClosed: true }
  // Every day defaults to Closed; a successful parse overwrites it. A day we
  // can't parse stays Closed (the import-validation flag below catches the
  // all-closed case so it doesn't pass silently).
  const weekDays: Record<string, HoursDay> = {};
  for (const day of DAY_NAMES) {
    weekDays[day] = { duration: null, isClosed: true };
  }

  if (!raw || !raw.trim()) return { weekDays };

  for (const { day, value } of splitGluedHours(raw)) {
    const parsed = parseDayValue(value);
    if (parsed) weekDays[day] = parsed;
  }

  return { weekDays };
}

const CATEGORY_MAP: Record<
  string,
  {
    industry: string;
    categories: string[];
  }
> = {};

for (const cat of [
  'Sushi restaurant',
  'Japanese restaurant',
  'Restaurant',
  'Pizza restaurant',
  'Italian restaurant',
  'Mexican restaurant',
  'Chinese restaurant',
  'Thai restaurant',
  'Indian restaurant',
  'American restaurant',
  'Seafood restaurant',
  'Steakhouse',
  'Burger restaurant',
  'Sandwich shop',
  'Fast food restaurant',
  'Diner',
  'Buffet',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Food & Drinks',
    categories: ['Restaurant'],
  };
}

for (const cat of ['Café', 'Cafe', 'Coffee shop', 'Tea house', 'Tea room']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Food & Drinks',
    categories: ['Café / Coffee'],
  };
}

for (const cat of [
  'Bar',
  'Pub',
  'Sports bar',
  'Cocktail bar',
  'Dive bar',
  'Gastropub',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Food & Drinks',
    categories: ['Bar / Pub'],
  };
}

for (const cat of [
  'Bakery',
  'Dessert shop',
  'Ice cream shop',
  'Donut shop',
  'Patisserie',
  'Cake shop',
  'Chocolate shop',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Food & Drinks',
    categories: ['Bakery / Dessert'],
  };
}

for (const cat of ['Food truck', 'Street food', 'Pop-up restaurant']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Food & Drinks',
    categories: ['Food Truck / Pop-up'],
  };
}

for (const cat of [
  'Brewery',
  'Winery',
  'Wine bar',
  'Distillery',
  'Taproom',
  'Vineyard',
  'Beer garden',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Food & Drinks',
    categories: ['Brewery / Winery'],
  };
}

for (const cat of [
  'Live music venue',
  'Concert hall',
  'Music venue',
  'Jazz club',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Entertainment',
    categories: ['Live Music'],
  };
}

for (const cat of [
  'Night club',
  'Nightclub',
  'Dance club',
  'Lounge',
  'Karaoke bar',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Entertainment',
    categories: ['Nightclub & Dance'],
  };
}

for (const cat of [
  'Movie theater',
  'Cinema',
  'Drive-in theater',
  'Theater',
  'Performing arts theater',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Entertainment',
    categories: ['Cinema / Theater'],
  };
}

for (const cat of ['Cultural center', 'Art center', 'Community center']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Entertainment',
    categories: ['Cultural & Arts'],
  };
}

for (const cat of ['Comedy club', 'Comedy show']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Entertainment',
    categories: ['Comedy Club'],
  };
}

for (const cat of ['Gym', 'Fitness center', 'CrossFit gym', 'Health club']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Sports & Outdoor',
    categories: ['Gym / Fitness'],
  };
}

for (const cat of ['Yoga studio', 'Pilates studio']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Sports & Outdoor',
    categories: ['Yoga / Pilates'],
  };
}

for (const cat of [
  'Sports complex',
  'Tennis court',
  'Basketball court',
  'Soccer field',
  'Swim club',
  'Swimming pool',
  'Ice skating rink',
  'Rock climbing gym',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Sports & Outdoor',
    categories: ['Sports Facility'],
  };
}

for (const cat of [
  'Hiking trail',
  'Kayak rental',
  'Surf school',
  'Zip line',
  'Outdoor recreation',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Sports & Outdoor',
    categories: ['Adventure / Outdoor'],
  };
}

for (const cat of [
  'Park',
  'Recreation center',
  'Playground',
  'Skate park',
  'Dog park',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Sports & Outdoor',
    categories: ['Parks / Recreation'],
  };
}

for (const cat of ['Bowling alley', 'Bowling center']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Activities & Experiences',
    categories: ['Bowling'],
  };
}

for (const cat of ['Amusement center', 'Arcade', 'Family fun center']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Activities & Experiences',
    categories: ['Arcades & Amusements'],
  };
}

for (const cat of ['Escape room', 'Board game café', 'Puzzle room']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Activities & Experiences',
    categories: ['Games & Challenges'],
  };
}

for (const cat of [
  'Mini golf',
  'Miniature golf',
  'Golf course',
  'Driving range',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Activities & Experiences',
    categories: ['Golf / Mini Golf'],
  };
}

for (const cat of [
  'Virtual reality center',
  'VR arcade',
  'Esports venue',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Activities & Experiences',
    categories: ['VR / Gaming'],
  };
}

for (const cat of [
  'Theme park',
  'Amusement park',
  'Water park',
  'Trampoline park',
  'Go-kart track',
  'Laser tag',
  'Axe throwing',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Activities & Experiences',
    categories: ['Adventure & Active Fun'],
  };
}

for (const cat of ['Spa', 'Massage', 'Day spa', 'Massage therapist']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Beauty & Wellness',
    categories: ['Spa & Massage'],
  };
}

for (const cat of [
  'Hair salon',
  'Barber shop',
  'Barbershop',
  'Hair stylist',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Beauty & Wellness',
    categories: ['Hair'],
  };
}

for (const cat of [
  'Beauty salon',
  'Makeup artist',
  'Eyelash service',
  'Eyebrow service',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Beauty & Wellness',
    categories: ['Beauty'],
  };
}

for (const cat of ['Nail salon', 'Nail studio']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Beauty & Wellness',
    categories: ['Nail'],
  };
}

for (const cat of ['Tattoo shop', 'Piercing studio', 'Aesthetic clinic']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Beauty & Wellness',
    categories: ['Aesthetic'],
  };
}

for (const cat of [
  'Med spa',
  'Medical spa',
  'Botox clinic',
  'Laser hair removal',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Beauty & Wellness',
    categories: ['Med spa'],
  };
}

for (const cat of [
  'Wellness center',
  'Holistic health',
  'Acupuncture',
  'Cryotherapy',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Beauty & Wellness',
    categories: ['Wellness'],
  };
}

for (const cat of [
  'Art class',
  'Pottery studio',
  'Painting studio',
  'Craft store with classes',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Clubs & Classes',
    categories: ['Art & Craft'],
  };
}

for (const cat of ['Music school', 'Performing arts school']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Clubs & Classes',
    categories: ['Music / Performing Arts'],
  };
}

CATEGORY_MAP['language school'] = {
  industry: 'Clubs & Classes',
  categories: ['Language & Cultural'],
};

for (const cat of ['Skill training center', 'Workshop space']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Clubs & Classes',
    categories: ['Skill Training'],
  };
}

for (const cat of ['Dance studio', 'Dance school']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Clubs & Classes',
    categories: ['Dance'],
  };
}

for (const cat of ['Cooking school', 'Cooking class']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Clubs & Classes',
    categories: ['Cooking'],
  };
}

CATEGORY_MAP['museum'] = {
  industry: 'Local Attractions',
  categories: ['Museum'],
};
CATEGORY_MAP['art gallery'] = {
  industry: 'Local Attractions',
  categories: ['Art Gallery'],
};
for (const cat of ['Tourist attraction', 'Cultural landmark', 'Heritage site']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Local Attractions',
    categories: ['Cultural Attraction'],
  };
}
for (const cat of ['Historical landmark', 'Monument', 'Historical site']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Local Attractions',
    categories: ['Historical Site / Landmark'],
  };
}
for (const cat of ['Botanical garden', 'Public garden', 'Arboretum']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Local Attractions',
    categories: ['Botanical Garden / Park'],
  };
}
for (const cat of ['Zoo', 'Aquarium', 'Wildlife park']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Local Attractions',
    categories: ['Zoo / Aquarium'],
  };
}

for (const cat of [
  'Plumber',
  'Electrician',
  'Handyman',
  'HVAC contractor',
  'Locksmith',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Local Services',
    categories: ['Home Repair'],
  };
}
for (const cat of ['Auto repair shop', 'Car wash', 'Tire shop', 'Mechanic']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Local Services',
    categories: ['Auto Services'],
  };
}
for (const cat of [
  'Veterinarian',
  'Pet groomer',
  'Pet boarding',
  'Dog walker',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Local Services',
    categories: ['Pet Care'],
  };
}
for (const cat of ['Tutor', 'Tutoring service', 'Test prep center']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Local Services',
    categories: ['Tutoring'],
  };
}
for (const cat of ['Cleaning service', 'Maid service', 'Janitorial service']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Local Services',
    categories: ['Cleaning'],
  };
}
for (const cat of ['Landscaper', 'Gardener', 'Lawn care service']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Local Services',
    categories: ['Landscaping'],
  };
}
for (const cat of [
  'Accountant',
  'Lawyer',
  'Marketing agency',
  'Consulting firm',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Local Services',
    categories: ['Business & Professional'],
  };
}

for (const cat of [
  'Clothing store',
  'Fashion store',
  'Boutique',
  'Apparel store',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Retail & Shopping',
    categories: ['Fashion & Apparel'],
  };
}
for (const cat of [
  'Specialty store',
  'Gift shop',
  'Bookstore',
  'Toy store',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Retail & Shopping',
    categories: ['Specialty / Boutique'],
  };
}
for (const cat of [
  'Supermarket',
  'Grocery store',
  'Convenience store',
  'Farmers market',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Retail & Shopping',
    categories: ['Grocery / Market'],
  };
}
for (const cat of [
  'Shoe store',
  'Jewelry store',
  'Accessories store',
  'Handbag store',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Retail & Shopping',
    categories: ['Shoes & Accessories'],
  };
}
for (const cat of ['Pop-up shop', 'Seasonal market', 'Flea market']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Retail & Shopping',
    categories: ['Pop-up / Seasonal'],
  };
}

for (const cat of ['Hotel', 'Motel', 'Resort', 'Inn']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Places to Stay',
    categories: ['Hotel / Resort'],
  };
}
for (const cat of ['Bed & Breakfast', 'B&B']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Places to Stay',
    categories: ['Bed & Breakfast'],
  };
}
for (const cat of ['Hostel', 'Guesthouse']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Places to Stay',
    categories: ['Hostel / Guesthouse'],
  };
}
for (const cat of [
  'Serviced apartment',
  'Extended stay hotel',
  'Apart-hotel',
]) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Places to Stay',
    categories: ['Serviced Apartment'],
  };
}
for (const cat of ['Campground', 'Glamping site', 'RV park']) {
  CATEGORY_MAP[cat.toLowerCase()] = {
    industry: 'Places to Stay',
    categories: ['Camping / Glamping'],
  };
}

function mapCategory(
  rawCategory: string,
  fallbackIndustry?: string,
  fallbackCategory?: string[],
): {
  industry: string;
  categories: string[];
  isFallback: boolean;
} {
  if (!rawCategory) {
    return {
      industry: fallbackIndustry || 'Food & Drinks',
      categories: fallbackCategory || ['Restaurant'],
      isFallback: true,
    };
  }

  const key = rawCategory.trim().toLowerCase();
  const exact = CATEGORY_MAP[key];
  if (exact) {
    return { ...exact, isFallback: false };
  }

  for (const [mapKey, mapVal] of Object.entries(CATEGORY_MAP)) {
    if (key.includes(mapKey) || mapKey.includes(key)) {
      return { ...mapVal, isFallback: false };
    }
  }

  return {
    industry: fallbackIndustry || 'Food & Drinks',
    categories: fallbackCategory || ['Restaurant'],
    isFallback: true,
  };
}

function generateTags(
  name: string,
  category: string,
  address: string,
  description: string,
): string[] {
  const words = new Set<string>();

  if (address) {
    const parts = address.split(',').map((s) => s.trim());
    if (parts.length >= 2) {
      const city =
        parts[parts.length - 3] || parts[parts.length - 2] || '';
      if (city) {
        words.add(city.toLowerCase().replace(/\s+/g, '-'));
      }
    }
  }

  if (category) {
    const catWords = category
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    for (const w of catWords.slice(0, 2)) {
      words.add(w);
    }
  }

  if (name) {
    const nameWords = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 2 && !['the', 'and', 'for', 'its'].includes(w),
      );
    for (const w of nameWords.slice(0, 2)) {
      words.add(w);
    }
  }

  if (description) {
    const descWords = description
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 3 &&
          ![
            'this',
            'that',
            'with',
            'from',
            'have',
            'been',
            'were',
            'your',
            'they',
            'will',
            'about',
            'their',
          ].includes(w),
      );
    for (const w of descWords.slice(0, 2)) {
      words.add(w);
    }
  }

  return Array.from(words).slice(0, 6);
}

function extractImageUrl(record: ScraperRecord): string | null {
  if (record.place_images) {
    const imgs = Array.isArray(record.place_images)
      ? record.place_images
      : [record.place_images];
    const first = imgs.find(
      (i: any) => typeof i === 'string' && i.startsWith('http'),
    );
    if (first) return first;
  }

  return (
    record.image ||
    record.photo ||
    record.image_url ||
    record.thumbnail ||
    null
  );
}

function normalizeEmailMap(raw: any): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || !entry.emails || !entry.url) continue;

      const emails = String(entry.emails)
        .split(',')
        .map((e: string) => e.trim())
        .filter(
          (e: string) => e && e.includes('@') && !e.endsWith('/'),
        );

      if (emails.length === 0) continue;

      const urlKey = String(entry.url).trim();
      normalized[urlKey] = emails;

      try {
        const domain = new URL(
          urlKey.startsWith('http') ? urlKey : `https://${urlKey}`,
        ).hostname.replace(/^www\./, '');
        if (domain) normalized[domain] = emails;
      } catch {
        // Invalid URL — skip domain extraction
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (Array.isArray(value)) {
        normalized[key] = value as string[];
      } else if (typeof value === 'string' && value) {
        normalized[key] = value
          .split(',')
          .map((e) => e.trim())
          .filter((e) => e && e.includes('@'));
      }
    }
  }

  return normalized;
}

// Detects "Suite 161" / "Ste 12B" / "Unit 4" / "Apt 9" / "#410" tokens.
const UNIT_TOKEN_RE = /^(suite|ste|unit|apt|apartment|#|fl|floor|room|rm)\b/i;

// Splits a single address string from the scraper into structured fields.
//
// Anchors:
//   1. A trailing 5-or-9-digit ZIP is the most reliable anchor.
//   2. The 2-letter state code immediately before the ZIP is the second anchor.
//   3. Comma boundaries split city / state-zip / country segments AFTER
//      the street+unit prefix is folded into address1/address2.
//
// Example:
//   "14460 New Falls of Neuse Rd Suite 161, Raleigh, NC 27614"
//   ->  address1   = "14460 New Falls of Neuse Rd"
//       address2   = "Suite 161"
//       city       = "Raleigh"
//       state      = "NC"
//       postalCode = "27614"
//       country    = ""
//
// Returns city/state as a best-effort guess. The caller is expected to
// override them via the managed locations list — this function intentionally
// does NOT try to defend against rare/exotic shapes.
function parseAddress(raw: string): {
  address1: string;
  address2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
} {
  const result = {
    address1: raw || '',
    address2: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
  };

  if (!raw || !raw.trim()) return result;

  // Strip pluscode prefix Google sometimes emits ("M5Q5+Q4 ").
  let working = raw.replace(/^[A-Z0-9]{4,}\+[A-Z0-9]{2,}\s+/, '').trim();

  // Whole-string ZIP capture as the trailing anchor.
  const zipMatch = working.match(/\b(\d{5}(?:-\d{4})?)\b\s*$/);
  if (zipMatch) {
    result.postalCode = zipMatch[1];
    working = working.slice(0, zipMatch.index).trim().replace(/,\s*$/, '');
  }

  // Trailing "USA"/"United States" -> country.
  const countryMatch = working.match(/,\s*(USA|United States(?: of America)?)\s*$/i);
  if (countryMatch) {
    result.country = 'United States';
    working = working.slice(0, countryMatch.index).trim().replace(/,\s*$/, '');
  }

  const parts = working.split(',').map((s) => s.trim()).filter(Boolean);

  // Trailing token is state (or "<state> <zip>" if zip wasn't already pulled).
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    // "NC 27614" residual safety net.
    const stateZip = last.match(/^([A-Z]{2}|[A-Za-z][A-Za-z\s]+?)\s+(\d{5}(?:-\d{4})?)$/);
    if (stateZip) {
      const norm = normalizeUsState(stateZip[1]);
      if (norm) result.state = norm;
      if (!result.postalCode) result.postalCode = stateZip[2];
      parts.pop();
    } else {
      const norm = normalizeUsState(last);
      if (norm) {
        result.state = norm;
        parts.pop();
      }
    }
  }

  // Next trailing token is the city (e.g. "Raleigh").
  if (parts.length > 0) {
    result.city = parts.pop()!.trim();
  }

  // Everything else is the street + optional unit.
  // We treat ", Suite 161" as address2 if present anywhere in the remaining tokens.
  const streetTokens: string[] = [];
  const unitTokens: string[] = [];
  for (const p of parts) {
    if (UNIT_TOKEN_RE.test(p)) {
      unitTokens.push(p);
    } else {
      streetTokens.push(p);
    }
  }

  // If the street still contains a trailing "Suite 161" without a comma
  // boundary, peel it off too. e.g. "14460 New Falls of Neuse Rd Suite 161"
  if (streetTokens.length > 0) {
    const last = streetTokens[streetTokens.length - 1];
    const suiteIdx = last.search(
      /\b(suite|ste|unit|apt|apartment|#|fl|floor|room|rm)\b/i,
    );
    if (suiteIdx > 0) {
      const street = last.slice(0, suiteIdx).trim().replace(/[,\s]+$/, '');
      const unit = last.slice(suiteIdx).trim();
      streetTokens[streetTokens.length - 1] = street;
      if (unit) unitTokens.unshift(unit);
    }
  }

  result.address1 = streetTokens.join(', ').trim();
  result.address2 = unitTokens.join(', ').trim();

  // If we ended up with nothing on address1 (degenerate single-token input)
  // fall back to the original raw string to avoid losing data entirely.
  if (!result.address1) {
    result.address1 = working || raw;
  }

  return result;
}

// ─── Stage B: import-validation guards ────────────────────────────────────
//
// Flag suspicious shapes that the scraper sometimes produces — cases
// where the data structurally disagrees with itself (e.g. US state with
// non-US coords, +1 phone in India). Each guard pushes a string into
// the per-record warnings array; the controller turns those into
// validationErrors with severity='warning' so the portal can surface
// them on the SeedingRecord row. We NEVER auto-correct here — the
// operator decides what to do via Data Repair.
//
// Tag every guard message with [stage-b] so the operator UI / logs can
// group them separately from city/state resolution warnings.

// Continental US + Alaska + Hawaii loose bounding-box. We're not
// trying to be perfectly precise — a near-miss just means a warning
// doesn't fire, which is safe. A miss in the other direction would
// flag a legitimate US business, which is annoying but recoverable.
function isUsCoord(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  // Continental
  if (lat >= 24 && lat <= 50 && lng >= -125 && lng <= -66) return true;
  // Alaska (very coarse)
  if (lat >= 51 && lat <= 72 && lng >= -180 && lng <= -130) return true;
  // Hawaii
  if (lat >= 18 && lat <= 23 && lng >= -161 && lng <= -154) return true;
  return false;
}

function appendStageBValidationWarnings(args: {
  state: string;
  city: string;
  country: string;
  countryCode: string;
  rawPhone: string;
  latitude: number;
  longitude: number;
  warnings: string[];
}): void {
  const { state, city, country, countryCode, rawPhone, latitude, longitude, warnings } = args;

  // Coords are considered "set" only when both values are non-zero —
  // the adapter defaults to (0, 0) for missing coords, and lat/lng == 0
  // is in the Atlantic, never a real venue we'd seed.
  const coordsSet = latitude !== 0 || longitude !== 0;
  const coordsInUs = coordsSet && isUsCoord(latitude, longitude);
  const stateLooksUs = !!state && !!normalizeUsState(state);

  // 1) US-state-abbrev with non-US coords — strongest contradiction;
  //    almost always a wrong-coord pair or a state mistakenly filled
  //    in for a non-US row.
  if (coordsSet && stateLooksUs && !coordsInUs) {
    warnings.push(
      `[stage-b] US state "${state}" but coordinates (${latitude}, ${longitude}) ` +
        `are outside the United States — check the address+coords pair`,
    );
  }

  // 2) Digits-only city — usually a postcode that slid into the city
  //    field (Indian PIN code stripped during a sloppy import). Trim
  //    first so " 11238 " is caught.
  if (city && /^\d+$/.test(city.trim())) {
    warnings.push(
      `[stage-b] City "${city}" is digits-only — likely a postcode in the city field`,
    );
  }

  // 3) +1 phone with non-US coords. parsePhone defaults to '+1' when
  //    no country code is present in the input, so we additionally
  //    require that the operator actually had SOMETHING in the raw
  //    phone — else "+1 + no phone + India coords" would always fire.
  if (
    coordsSet &&
    !coordsInUs &&
    countryCode === '+1' &&
    typeof rawPhone === 'string' &&
    rawPhone.trim().length > 0
  ) {
    warnings.push(
      `[stage-b] Phone country code "+1" with non-US coordinates ` +
        `(${latitude}, ${longitude}) — possible wrong default countryCode`,
    );
  }

  // 4) Missing country, but the record has enough address data that we
  //    expected one. Don't warn on a record that has NOTHING (those
  //    will get caught by the city-unresolved guards above).
  if (!country && (state || city)) {
    warnings.push(
      '[stage-b] Country field is missing — the address has state/city ' +
        'but no country anchor',
    );
  }
}

// Stage B data-quality flags. Unlike the contradiction checks above (which
// compare fields against each other) these flag a single field that is
// structurally unusable downstream — no real address, hours that didn't
// parse, junk coords/name, or a missing placeId. Each flag BOTH pushes a
// [stage-b] warning (→ validationError, surfaced on the SeedingRecord row)
// AND bumps a stats counter, so the operator sees aggregate data quality in
// the import summary before running the pipeline. We flag, never correct.
function appendStageBDataQualityFlags(args: {
  name: string;
  placeId: string;
  address1: string;
  rawHours: string;
  openDayCount: number;
  latitude: number;
  longitude: number;
  warnings: string[];
  stats: {
    hoursUnparsed: number;
    addressInvalid: number;
    noCoords: number;
    noPlaceId: number;
    noName: number;
  };
}): void {
  const {
    name,
    placeId,
    address1,
    rawHours,
    openDayCount,
    latitude,
    longitude,
    warnings,
    stats,
  } = args;

  // ── EMPTY/JUNK NAME ──
  if (!name || name.trim().length < 2) {
    stats.noName++;
    warnings.push(
      `[stage-b] Name is empty or under 2 chars ("${name}") — likely a ` +
        'junk/blank record',
    );
  }

  // ── MISSING PLACEID ──
  if (!placeId || !placeId.trim()) {
    stats.noPlaceId++;
    warnings.push(
      '[stage-b] placeId is empty — record cannot be resolved/deduped ' +
        'downstream',
    );
  }

  // ── ADDRESS-IS-NOT-AN-ADDRESS ──
  // After parseAddress, address1 should be a street line. Flag the
  // confirmed real-data failures: a phone number ("+1 802-347-3562"),
  // a URL / social handle / domain, or an empty string.
  const addr = (address1 || '').trim();
  const addrIsPhone = /^\+?\d[\d\s\-()]+$/.test(addr);
  const addrIsUrl = /\.com|http|www\.|instagram|facebook/i.test(addr);
  if (!addr || addrIsPhone || addrIsUrl) {
    stats.addressInvalid++;
    const why = !addr
      ? 'empty'
      : addrIsPhone
        ? 'a phone number'
        : 'a URL/handle';
    warnings.push(
      `[stage-b] address1 "${address1}" is ${why}, not a street address — ` +
        'needs a real address',
    );
  }

  // ── HOURS-PRESENT-BUT-UNPARSED ──
  // raw.hours had content but parseHours produced ZERO open days — the
  // format didn't match and the business would import all-closed wrongly.
  const hasRawHours = !!rawHours && rawHours.trim().length > 0;
  if (hasRawHours && openDayCount === 0) {
    stats.hoursUnparsed++;
    warnings.push(
      '[stage-b] Hours were present but none parsed — all 7 days would ' +
        'import as Closed; check the hours format',
    );
  }

  // ── NO-HOURS ──
  // raw.hours empty/missing. Flagged (no dedicated counter) so an
  // all-closed import is distinguishable from genuinely-closed real hours;
  // distinct from hoursUnparsed, which means a format we couldn't read.
  if (!hasRawHours) {
    warnings.push(
      '[stage-b] No hours captured — record will import with all days ' +
        'Closed by default',
    );
  }

  // ── ZERO/MISSING COORDS ──
  // The adapter defaults missing coords to (0, 0); a real venue is never at
  // (0, 0) (null-island in the Atlantic), so treat it as "no real coords".
  if (latitude === 0 && longitude === 0) {
    stats.noCoords++;
    warnings.push(
      '[stage-b] Coordinates are (0, 0) — no real location captured',
    );
  }
}

function normalizeWebsite(url: string): string | null {
  if (!url || !url.trim()) return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

export function adaptScraperData(
  scraperData: ScraperRecord[],
  emailMap: EmailMap,
  options?: {
    defaultIndustry?: string;
    defaultCategories?: string[];
    defaultCity?: string;
    defaultState?: string;
    locations?: AdapterLocationCity[];
  },
): AdapterResult {
  const stats = {
    processed: 0,
    noWebsite: 0,
    emailMatched: 0,
    emailUnmatched: 0,
    categoryMapped: 0,
    categoryFallback: 0,
    cityResolved: 0,
    cityDefaulted: 0,
    cityUnresolved: 0,
    areaInList: 0,
    areaKeptCustom: 0,
    hoursUnparsed: 0,
    addressInvalid: 0,
    noCoords: 0,
    noPlaceId: 0,
    noName: 0,
  };

  const emailLookup = normalizeEmailMap(emailMap);
  const locationIndex = buildLocationIndex(options?.locations);

  // Resolve operator defaults to canonical city entries upfront.
  const defaultCityKey = options?.defaultCity?.trim().toLowerCase();
  const defaultCityEntry = defaultCityKey
    ? locationIndex.citiesByKey.get(defaultCityKey)
    : undefined;
  const defaultStateNorm = normalizeUsState(options?.defaultState);

  const records = scraperData.map((raw) => {
    stats.processed++;

    const recordWarnings: string[] = [];

    const placeId =
      extractPlaceId(raw.url || '') || raw.placeId || raw.place_id || '';

    const name = raw.place_name || raw.name || '';

    const addressRaw = raw.address || raw.address1 || '';
    const parsedAddress = parseAddress(addressRaw);

    // ── Address split ──────────────────────────────────────
    // Trust parseAddress for street/unit/postal-code. City/state
    // are revisited below — parsed values are first-pass guesses only.
    const address1 =
      raw.addressLine1 || raw.address1_line1 || parsedAddress.address1;
    const address2 =
      raw.addressLine2 || raw.address2 || parsedAddress.address2;
    const postalCode =
      raw.postalCode || raw.zip || parsedAddress.postalCode;
    const country = raw.country || parsedAddress.country;

    const parsedCity = (raw.city || parsedAddress.city || '').trim();
    const parsedState = (raw.state || parsedAddress.state || '').trim();

    // ── City / State / Area resolution ─────────────────────
    //
    // CORE PRINCIPLE:
    //   - A location-entry's top-level `city` name is NEVER written into
    //     a record's `city` field. It contributes STATE only and scopes
    //     the area-match candidate set.
    //   - The record's OWN parsed/raw city wins for the `city` field.
    //   - Area matches set `locality` (and MAY override `state`), but
    //     NEVER set `city`.

    let resolvedCity: string | null = null;
    let resolvedState: string | null = null;
    let resolvedLocality: string | null = null;
    let matchedAreaEntry: AdapterLocationArea | null = null;

    // ── STATE: anchor from operator selection / modal default ──
    // defaultState (modal) and entry.state share top authority.
    // When both are set we prefer the explicit modal default — that's
    // the operator changing state after the city auto-fill, so it's a
    // more direct signal than the city's default.
    if (defaultStateNorm) {
      resolvedState = defaultStateNorm;
    } else if (defaultCityEntry) {
      resolvedState = defaultCityEntry.state;
    }

    // ── AREA / LOCALITY discovery ──
    // Build a single haystack from address + parsed city + parsed state
    // so we catch things like "Hoboken" appearing in the raw address.
    const areaHaystack = [addressRaw, parsedCity, parsedState]
      .filter(Boolean)
      .join(' | ')
      .toLowerCase();

    if (defaultCityEntry) {
      // Operator-selected entry — search ONLY within its area set to
      // avoid cross-city false positives.
      const areaKey = findAreaInText(
        areaHaystack,
        defaultCityEntry.areasByKey.keys(),
      );
      if (areaKey) {
        matchedAreaEntry = defaultCityEntry.areasByKey.get(areaKey) ?? null;
      }
    } else {
      // No operator entry — fall back to the global area index.
      const areaKey = findAreaInText(
        areaHaystack,
        locationIndex.areaToCities.keys(),
      );
      if (areaKey) {
        const matches = locationIndex.areaToCities.get(areaKey)!;
        if (matches.length === 1) {
          matchedAreaEntry =
            matches[0].areasByKey.get(areaKey) ?? null;
          // Area belongs to exactly one city — adopt that city's state
          // when we still have no state set (matches.length === 1 means
          // no ambiguity). We intentionally do NOT set resolvedCity.
          if (!resolvedState) resolvedState = matches[0].state;
        } else if (matches.length > 1) {
          recordWarnings.push(
            `Area "${areaKey}" matches multiple cities — leaving unresolved`,
          );
        }
      }
    }

    // Per-area state override — beats both the entry default and any
    // global area state already applied (e.g. "Jersey Side" -> NJ in the
    // pre-split seed; same mechanism still works for any future override).
    if (matchedAreaEntry?.state) {
      const norm = normalizeUsState(matchedAreaEntry.state);
      if (norm) resolvedState = norm;
    }

    // ── CITY: record's own data only ──
    // Take parsedCity, then run it through a US-state-name guard so a
    // value like "New Jersey" / "NJ" / "California" is blanked instead
    // of being written into the city field. The operator entry name is
    // never substituted.
    if (parsedCity) {
      const looksLikeState = normalizeUsState(parsedCity);
      if (looksLikeState) {
        recordWarnings.push(
          'City field contained a state name — left empty for review',
        );
        // Leave resolvedCity null — caller renders as empty + warning.
      } else {
        resolvedCity = parsedCity;
        stats.cityResolved++;
      }
    }

    if (!resolvedCity) {
      stats.cityUnresolved++;
      // Only push the generic warning if the state-name guard didn't
      // already push its own.
      if (!parsedCity) {
        recordWarnings.push('City could not be resolved from the address');
      }
    }

    // ── STATE: parsed fallback when nothing has been set yet ──
    if (!resolvedState) {
      const parsedNorm = normalizeUsState(parsedState);
      if (parsedNorm) {
        resolvedState = parsedNorm;
      } else if (parsedState) {
        recordWarnings.push(
          `State "${parsedState}" is not a valid US state code — left empty`,
        );
      } else {
        recordWarnings.push('State could not be resolved from the address');
      }
    }

    // ── LOCALITY: matched area's canonical name, else raw, else nothing ──
    // (Area NEVER sets city — already enforced above.)
    if (matchedAreaEntry) {
      resolvedLocality = matchedAreaEntry.name;
      stats.areaInList++;
    } else {
      const rawLocality = raw.locality || raw.area || raw.neighborhood;
      if (rawLocality && typeof rawLocality === 'string') {
        resolvedLocality = rawLocality.trim();
        stats.areaKeptCustom++;
        recordWarnings.push(
          `Area "${resolvedLocality}" not in managed list — kept as-is`,
        );
      }
    }

    // stats.cityDefaulted is kept for back-compat but never increments —
    // we no longer default the city field from the operator entry.

    const city = resolvedCity ?? '';
    const state = resolvedState ?? '';

    let latitude = 0;
    let longitude = 0;
    if (raw.coordinates) {
      const coords = parseCoordinates(raw.coordinates);
      if (coords) {
        latitude = coords.latitude;
        longitude = coords.longitude;
      }
    } else if (raw.latitude && raw.longitude) {
      latitude = parseFloat(String(raw.latitude));
      longitude = parseFloat(String(raw.longitude));
    }

    const rating = parseRating(raw.rating || raw.stars || 0);

    const userRatingCount = parseReviewCount(
      raw.review_count || raw.userRatingCount || 0,
    );

    const parsedPhone = parsePhone(raw.phone || '');
    const phone = parsedPhone.phone;
    const countryCode = resolveCountryCode({
      hadPrefix: parsedPhone.hadPrefix,
      prefix: parsedPhone.countryCode,
      country: country ?? '',
      state,
      latitude,
      longitude,
      warnings: recordWarnings,
    });

    const website = normalizeWebsite(raw.website || '');
    if (!website) stats.noWebsite++;

    const description =
      raw.description ||
      raw.about ||
      raw.editorial_summary ||
      raw.summary ||
      '';

    const imageUrl = extractImageUrl(raw);

    const regularTiming = parseHours(
      raw.hours || raw.operating_hours || '',
    );
    if (raw.regularTiming) {
      Object.assign(regularTiming, raw.regularTiming);
    }

    const categoryResult = mapCategory(
      raw.category || '',
      options?.defaultIndustry,
      options?.defaultCategories,
    );
    if (categoryResult.isFallback) {
      stats.categoryFallback++;
    } else {
      stats.categoryMapped++;
    }

    let emails: string[] | undefined;

    if (placeId && emailLookup[placeId]) {
      emails = emailLookup[placeId];
    }

    if (!emails && website) {
      if (emailLookup[website]) {
        emails = emailLookup[website];
      } else {
        const cleanUrl = website.replace(/\/$/, '');
        if (emailLookup[cleanUrl]) {
          emails = emailLookup[cleanUrl];
        }
      }
    }

    if (!emails && website) {
      try {
        const domain = new URL(website).hostname.replace(/^www\./, '');
        if (emailLookup[domain]) {
          emails = emailLookup[domain];
        }
      } catch {
        // Invalid URL — skip domain lookup
      }
    }

    if (!emails) {
      const rawEmail = raw.email || raw.emails;
      if (rawEmail) {
        const parsed = String(rawEmail)
          .split(',')
          .map((e) => e.trim())
          .filter(
            (e) => e && e.includes('@') && !e.endsWith('/'),
          );
        if (parsed.length > 0) {
          emails = parsed;
        }
      }
    }

    const tags = generateTags(
      name,
      raw.category || '',
      address1,
      description,
    );

    const record: any = {
      placeId,
      name,
      address1,
      city,
      state,
      postalCode,
      latitude,
      longitude,
      rating,
      userRatingCount,
      countryCode,
      phone,
      industry: categoryResult.industry,
      categories: categoryResult.categories,
      regularTiming,
      tags,
      // Every seeded business enters the pipeline at the post-cover
      // confetti screen and must NOT auto-advance the onboarding journey —
      // the operator drives activation from here.
      status: BusinessStatus.CONFETTI_SCREEN, // 4.1
      continueJourney: false,
    };

    if (address2) record.address2 = address2;
    if (resolvedLocality) record.locality = resolvedLocality;
    if (country) record.country = country;
    if (website) record.website = website;
    if (description) record.description = description;
    if (imageUrl) {
      record.logo = imageUrl;
      record.cover = imageUrl;
    }
    if (emails && emails.length > 0) {
      record.email = emails[0];
      record.marketingEmails = [...new Set(emails)];
      stats.emailMatched++;
    } else {
      stats.emailUnmatched++;
    }

    // Stage B import-validation guards. Operates on the fully built
    // record so the checks see post-normalisation values (e.g. state
    // already an abbrev, countryCode resolved from parsePhone). These
    // flow through the same __warnings → validationErrors pipeline as
    // the city/state warnings above, so the operator sees them on the
    // SeedingRecord row without any new schema or UI surface.
    appendStageBValidationWarnings({
      state,
      city,
      country: country ?? '',
      countryCode,
      rawPhone: raw.phone || '',
      latitude,
      longitude,
      warnings: recordWarnings,
    });

    // Stage B data-quality flags (import-time gaps that caused major
    // downstream cleanup). openDayCount drives the HOURS-PRESENT-BUT-UNPARSED
    // check — a day is "open" only when the parser wrote isClosed: false.
    const openDayCount = Object.values(
      (regularTiming as any).weekDays ?? {},
    ).filter((d: any) => d && d.isClosed === false).length;

    appendStageBDataQualityFlags({
      name,
      placeId,
      address1,
      rawHours: String(raw.hours ?? raw.operating_hours ?? ''),
      openDayCount,
      latitude,
      longitude,
      warnings: recordWarnings,
      stats,
    });

    if (recordWarnings.length > 0) {
      // Transient field — the controller strips this before persisting,
      // converting each entry into a validationErrors warning.
      Object.defineProperty(record, '__warnings', {
        value: recordWarnings,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }

    return record;
  });

  return { records, stats };
}
