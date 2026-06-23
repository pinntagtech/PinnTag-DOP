export interface CvbIssue {
  field: string;
  issue: string;
  currentValue: any;
  suggestedValue: any;
  riskLevel: 'safe' | 'manual';
}

const VALID_INDUSTRIES = [
  'Food & Drinks',
  'Entertainment',
  'Sports & Outdoor',
  'Activities & Experiences',
  'Beauty & Wellness',
  'Clubs & Classes',
  'Local Attractions',
  'Local Services',
  'Retail & Shopping',
  'Places to Stay',
];

function normalisePhone(phone: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  if (digits.length === 10) return digits;
  return null;
}

function normaliseUrl(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function normaliseEmail(email: string): string | null {
  if (!email) return null;
  return email.trim().toLowerCase();
}

function normaliseTags(tags: string[]): string[] {
  if (!tags || !Array.isArray(tags)) return [];
  return tags
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
    .filter(Boolean)
    .filter((t, i, arr) => arr.indexOf(t) === i);
}

export function validateCvbBusiness(
  business: Record<string, any>,
): CvbIssue[] {
  const issues: CvbIssue[] = [];

  // ── SAFE FIXES ──────────────────────────────────────

  if (business.phone) {
    const normalised = normalisePhone(business.phone);
    if (normalised && normalised !== business.phone) {
      issues.push({
        field: 'phone',
        issue: 'Phone number format incorrect',
        currentValue: business.phone,
        suggestedValue: normalised,
        riskLevel: 'safe',
      });
    }
  } else {
    issues.push({
      field: 'phone',
      issue: 'Phone number missing',
      currentValue: null,
      suggestedValue: null,
      riskLevel: 'manual',
    });
  }

  if (business.email) {
    const normalised = normaliseEmail(business.email);
    if (normalised !== business.email) {
      issues.push({
        field: 'email',
        issue: 'Email has incorrect casing or whitespace',
        currentValue: business.email,
        suggestedValue: normalised,
        riskLevel: 'safe',
      });
    }
  } else {
    issues.push({
      field: 'email',
      issue: 'Email missing',
      currentValue: null,
      suggestedValue: null,
      riskLevel: 'manual',
    });
  }

  if (business.website) {
    const normalised = normaliseUrl(business.website);
    if (normalised && normalised !== business.website) {
      issues.push({
        field: 'website',
        issue: 'Website URL missing https://',
        currentValue: business.website,
        suggestedValue: normalised,
        riskLevel: 'safe',
      });
    }
  } else {
    issues.push({
      field: 'website',
      issue: 'Website missing',
      currentValue: null,
      suggestedValue: null,
      riskLevel: 'manual',
    });
  }

  if (business.tags && Array.isArray(business.tags)) {
    const normalised = normaliseTags(business.tags);
    const isDifferent = JSON.stringify(normalised) !==
      JSON.stringify(business.tags);
    if (isDifferent) {
      issues.push({
        field: 'tags',
        issue: 'Tags have inconsistent formatting',
        currentValue: business.tags,
        suggestedValue: normalised,
        riskLevel: 'safe',
      });
    }
  } else {
    issues.push({
      field: 'tags',
      issue: 'Tags missing',
      currentValue: [],
      suggestedValue: [],
      riskLevel: 'safe',
    });
  }

  if (!business.countryCode) {
    issues.push({
      field: 'countryCode',
      issue: 'Country code missing — defaulting to +1',
      currentValue: null,
      suggestedValue: '+1',
      riskLevel: 'safe',
    });
  }

  // ── MANUAL FIXES ────────────────────────────────────

  if (!business.placeId) {
    issues.push({
      field: 'placeId',
      issue: 'Google Maps placeId missing — enrichment required',
      currentValue: null,
      suggestedValue: null,
      riskLevel: 'manual',
    });
  }

  if (!business.addressLine1) {
    issues.push({
      field: 'addressLine1',
      issue: 'Address line 1 missing',
      currentValue: null,
      suggestedValue: null,
      riskLevel: 'manual',
    });
  }

  if (!business.city) {
    issues.push({
      field: 'city',
      issue: 'City missing',
      currentValue: null,
      suggestedValue: null,
      riskLevel: 'manual',
    });
  }

  if (!business.latitude || !business.longitude) {
    issues.push({
      field: 'coordinates',
      issue: 'Latitude/longitude missing',
      currentValue: {
        lat: business.latitude,
        lng: business.longitude,
      },
      suggestedValue: null,
      riskLevel: 'manual',
    });
  }

  if (!business.logo && !business.logoUploaded) {
    issues.push({
      field: 'logo',
      issue: business.placeId
        ? 'Logo missing — can be fetched from Google Maps'
        : 'Logo missing',
      currentValue: null,
      suggestedValue: business.placeId
        ? '__fetch_from_bot__'
        : null,
      riskLevel: business.placeId ? 'safe' : 'manual',
    });
  }

  if (!business.cover && !business.coverUploaded) {
    issues.push({
      field: 'cover',
      issue: business.placeId
        ? 'Cover missing — can be fetched from Google Maps'
        : 'Cover missing',
      currentValue: null,
      suggestedValue: business.placeId
        ? '__fetch_from_bot__'
        : null,
      riskLevel: business.placeId ? 'safe' : 'manual',
    });
  }

  if (!business.regularTiming ||
      !business.regularTiming?.weekDays) {
    issues.push({
      field: 'regularTiming',
      issue: 'Business hours missing — requires manual input or bot scrape',
      currentValue: null,
      suggestedValue: null,
      riskLevel: 'manual',
    });
  }

  return issues;
}
