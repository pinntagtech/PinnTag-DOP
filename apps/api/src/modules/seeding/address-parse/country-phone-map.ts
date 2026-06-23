// Country name → ITU dialling code. Kept SMALL on purpose — we only
// map the countries DOP actually seeds. A miss returns null, the
// caller flags addressStatus='address_unparsed' rather than guessing.
//
// Match logic: case-insensitive, trims, and accepts a small set of
// common alternates ("USA" → United States, "UK" → United Kingdom).
// libpostal normalises most of these for us but we still see operator
// CSV imports with stray casing.

export const COUNTRY_PHONE_MAP: Record<string, string> = {
  'united states': '+1',
  'united states of america': '+1',
  usa: '+1',
  'u.s.a.': '+1',
  us: '+1',
  india: '+91',
  bharat: '+91',
  canada: '+1',
  'united kingdom': '+44',
  uk: '+44',
  'great britain': '+44',
  australia: '+61',
  ireland: '+353',
  'new zealand': '+64',
  singapore: '+65',
  'united arab emirates': '+971',
  uae: '+971',
};

export function lookupCountryPhoneCode(
  countryName: string | null | undefined,
): string | null {
  if (!countryName || typeof countryName !== 'string') return null;
  return COUNTRY_PHONE_MAP[countryName.trim().toLowerCase()] ?? null;
}

// Country-only fallback from a (lat, lng) pair. Used ONLY when the
// parsed address has no `country` component AND the business has
// stored coordinates — the brief's India case. We never override a
// libpostal-derived country with this; the caller is responsible for
// gating the call.
//
// Boxes are deliberately coarse — we'd rather miss than mis-attribute
// (a missed inference just falls through to addressStatus='unparsed',
// which is harmless; a wrong one would propagate bad countryCode).
type LatLngBox = {
  country: string;
  // [southLat, northLat, westLng, eastLng]
  bbox: [number, number, number, number];
};

const COUNTRY_BBOXES: LatLngBox[] = [
  { country: 'India', bbox: [6, 36, 68, 98] },
  // Continental US only; AK/HI excluded on purpose — the spec
  // example was US lower-48 vs India, and the address row IS expected
  // to carry "United States" when it's the US, so this fallback only
  // fires for India in practice.
];

export function inferCountryFromLatLng(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (
    typeof lat !== 'number' ||
    !Number.isFinite(lat) ||
    typeof lng !== 'number' ||
    !Number.isFinite(lng)
  ) {
    return null;
  }
  for (const box of COUNTRY_BBOXES) {
    const [s, n, w, e] = box.bbox;
    if (lat >= s && lat <= n && lng >= w && lng <= e) return box.country;
  }
  return null;
}
