// FIX 3 (recover-resolve-failures.md): drop junk from the resolve
// query fields BEFORE handing them to the bot. Two failure modes we
// cover here:
//   1) addressLine1 holds a phone / URL / hours text / an ambiguous
//      free-form string — the concatenated Maps query lands nowhere.
//   2) city/state carry foreign values (Barcelona / Catalunya) while
//      the business is domestic — Maps chases the wrong region.
//
// A dropped field is replaced with '' so the bot's existing query
// builder skips it. The bot is not aware of coords, so this call MUST
// happen API-side before enqueueing the ScrapeRequest.

import {
  US_LAT_MAX,
  US_LAT_MIN,
  US_LNG_MAX,
  US_LNG_MIN,
  extractCoords,
} from '../console/gate-predicates';

// Reject addressLine1 that's actually a phone number.
const PHONE_ONLY_RE = /^\+?[\d\s().-]{7,}$/;

// Reject addressLine1 that's actually a URL or bare domain.
const URL_RE = /^\s*(https?:\/\/|www\.)/i;
const DOMAIN_TAIL_RE = /\.[a-z]{2,4}\b/i;
const HAS_DIGIT_RE = /\d/;

// Reject addressLine1 that carries hours text.
const HOURS_TEXT_RE =
  /\b(?:open\s+24\s+hours?|closed|hours?[:\s])/i;

// "Miami, FL 33131" — postal fragment only, no street. Bot search
// treats this as noise; better to send only name + city + state.
const POSTAL_ONLY_RE = /^[^,]+,\s*[A-Za-z]{2}\s+\d{5}(?:-\d{4})?\s*$/;

// Recognise street-type tokens. Overlaps the write-guard's set on
// purpose — this is the READ side (deciding to drop from the query),
// not the write side (deciding whether to persist).
const STREET_TOKEN_RE =
  /\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|hwy|highway|pkwy|parkway|ter|terrace|cir|circle|sq|square|broadway|turnpike|tpke|trail|trl|loop|alley|aly|row|walk|plaza|plz|crossing|xing)\b/i;

const US_STATES: ReadonlySet<string> = new Set(
  [
    'alabama','alaska','arizona','arkansas','california','colorado',
    'connecticut','delaware','florida','georgia','hawaii','idaho',
    'illinois','indiana','iowa','kansas','kentucky','louisiana','maine',
    'maryland','massachusetts','michigan','minnesota','mississippi',
    'missouri','montana','nebraska','nevada','new hampshire','new jersey',
    'new mexico','new york','north carolina','north dakota','ohio',
    'oklahoma','oregon','pennsylvania','rhode island','south carolina',
    'south dakota','tennessee','texas','utah','vermont','virginia',
    'washington','west virginia','wisconsin','wyoming',
    'district of columbia','dc','puerto rico','pr',
    'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il',
    'in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt',
    'ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri',
    'sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy',
  ].map((s) => s.toLowerCase()),
);

function isUsState(v: string | null | undefined): boolean {
  const s = (v ?? '').toString().trim().toLowerCase();
  if (!s) return false;
  return US_STATES.has(s);
}

function coordsInsideUs(lat: number, lng: number): boolean {
  return (
    lat >= US_LAT_MIN &&
    lat <= US_LAT_MAX &&
    lng >= US_LNG_MIN &&
    lng <= US_LNG_MAX
  );
}

/** Should this addressLine1 be dropped from the search query? */
export function addressLine1IsJunk(raw: string | null | undefined): boolean {
  const s = (raw ?? '').toString().trim();
  if (!s) return false;                       // empty is not junk — caller handles it
  if (PHONE_ONLY_RE.test(s)) return true;
  if (URL_RE.test(s)) return true;
  if (HOURS_TEXT_RE.test(s)) return true;
  // "example.com" or "fresha.com" — bare domain, no digit, tail like ".com".
  if (DOMAIN_TAIL_RE.test(s) && !HAS_DIGIT_RE.test(s)) return true;
  // "City, ST 12345" — postal-only fragment (no street part). The zip
  // has digits so the below street-token check would keep it; drop
  // explicitly so the bot falls back to name + city/state.
  if (POSTAL_ONLY_RE.test(s) && !STREET_TOKEN_RE.test(s)) return true;
  // No digit AND no street token — probably a service name ("Services",
  // "Yoga", the business's own tagline). Bare landmarks with neither
  // signal ("The Metropolitan Opera House") get dropped too; the bot
  // will fall back to name + city/state which is usually enough.
  if (!HAS_DIGIT_RE.test(s) && !STREET_TOKEN_RE.test(s)) return true;
  return false;
}

/** Should this city value be dropped? Same phone/URL guards as addressLine1. */
export function cityIsJunk(raw: string | null | undefined): boolean {
  const s = (raw ?? '').toString().trim();
  if (!s) return false;
  if (PHONE_ONLY_RE.test(s)) return true;
  if (URL_RE.test(s)) return true;
  if (DOMAIN_TAIL_RE.test(s) && !HAS_DIGIT_RE.test(s)) return true;
  return false;
}

export interface SanitizedResolveFields {
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  droppedAddress: boolean;
  droppedCityState: boolean;
}

/**
 * Given a business's raw address fields plus its document (used for
 * coordinate extraction), return the fields the bot should actually
 * search with. Any dropped field is returned as ''.
 */
export function sanitizeResolveQueryFields(
  raw: {
    addressLine1?: string | null;
    address1?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  },
  doc: Record<string, any>,
): SanitizedResolveFields {
  const a1 = (raw.addressLine1 || raw.address1 || '').toString().trim();
  const city = (raw.city || '').toString().trim();
  const state = (raw.state || '').toString().trim();
  const postal = (raw.postalCode || '').toString().trim();

  const droppedAddress = addressLine1IsJunk(a1);
  const outAddress = droppedAddress ? '' : a1;

  // City/state contradict coords when coordinates are inside US bounds
  // but the stored state is not recognisable as a US state. This is
  // the "US business carrying Spanish city" pattern.
  const coords = extractCoords(doc);
  let droppedCityState = false;
  if (coords && coordsInsideUs(coords.lat, coords.lng)) {
    if (state && !isUsState(state)) {
      droppedCityState = true;
    }
  }
  // A city that's a phone/URL never helps the search — drop it too
  // (but keep state, which is usually still a legitimate US state).
  const cityJunk = cityIsJunk(city);
  const outCity = droppedCityState || cityJunk ? '' : city;
  const outState = droppedCityState ? '' : state;

  return {
    addressLine1: outAddress,
    city: outCity,
    state: outState,
    postalCode: postal,
    droppedAddress,
    droppedCityState,
  };
}

export interface QuerySanitizerCounters {
  total: number;
  droppedAddress: number;
  droppedCityState: number;
}

export function buildQuerySanitizerCounters(): QuerySanitizerCounters {
  return { total: 0, droppedAddress: 0, droppedCityState: 0 };
}
