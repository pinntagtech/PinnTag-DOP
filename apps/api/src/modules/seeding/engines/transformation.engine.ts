import { SeedingModules } from '../../../common/constants';
import {
  BusinessCreatorType,
  BusinessStatus,
  ScalabilityFactor,
  VerificationStatus,
  ConnectStatus,
  EventStatus,
} from '../../../common/enums';

export class TransformationEngine {
  transform(module: string, rawData: any): any {
    // Step 1 — deep clone so we never mutate rawData
    let data = JSON.parse(JSON.stringify(rawData));

    // Step 2 — apply global cleaners
    data = this.removeNullFields(data);
    data = this.trimStrings(data);
    data = this.normalizeArrayFields(data);

    // Step 3 — apply module-specific transform
    switch (module) {
      case SeedingModules.BUSINESS:
        return this.transformBusiness(data);
      case SeedingModules.OUTLET:
        return this.transformOutlet(data);
      case SeedingModules.EVENT:
        return this.transformEvent(data);
      default:
        return this.applyDefaults(data);
    }
  }

  private transformBusiness(data: any): any {
    // Inject required fields that raw data won't have
    data.creatorType = BusinessCreatorType.ADMIN;
    data.status = BusinessStatus.CONFETTI_SCREEN;
    data.isFromCrawler = true;
    data.isActive = true;
    data.isClaimed = false;
    data.isDeleted = false;
    data.followersCount = data.followersCount ?? 0;
    data.followingCount = data.followingCount ?? 0;
    data.viewsCount = data.viewsCount ?? 0;
    data.boostOrder = data.boostOrder ?? 1000;
    data.profileCompletionPercentage = 0;
    data.aiTrainingPercentage = 0;
    data.showVerificationBanner = true;
    data.verificationStatus = VerificationStatus.NOT_VERIFIED;
    data.connectStatus = ConnectStatus.NOT_INITIALISED;
    data.scalabilityFactor = ScalabilityFactor.SINGLE;

    // Pass-through fields from rawData — preserved as-is.
    // rating, userRatingCount, regularTiming, logo, cover, marketingEmails
    // are already on `data` via the deep clone; no transformation needed.

    // Rename raw schema variants — address1/address2/zip → addressLine1/addressLine2/postalCode
    // so outlet activation gets populated address fields without needing Google Places enrichment.
    data.addressLine1 = data.addressLine1 || data.address1;
    data.addressLine2 = data.addressLine2 || data.address2 || '';
    data.postalCode = data.postalCode || data.zip;

    // city / state are AUTHORITATIVE here — they were resolved against the
    // managed locations list inside adaptScraperData (scraper-adapter.ts) or
    // came in already-correct from upstream. Do NOT re-parse or re-derive
    // them from the address string in this engine; that's how the
    // "Raleigh in the state field" corruption was introduced previously.
    // Pass-through only.

    // Default to false; enrichment flips to true only if Google API is called
    data.dataFetchedFromGoogle = false;

    // Build geo location if coordinates present
    if (data.latitude && data.longitude) {
      data.location = {
        type: 'Point',
        coordinates: [Number(data.longitude), Number(data.latitude)],
      };
    }

    // Normalize phone — strip non-numeric except leading +
    if (data.phone) {
      data.phone = String(data.phone).replace(/[^\d]/g, '');
    }

    // Normalize website URL
    if (data.website) {
      const trimmed = data.website.trim();
      if (!/^https?:\/\//i.test(trimmed)) {
        data.website = `https://${trimmed}`;
      }
      // Remove invalid URLs silently
      if (!/^https?:\/\/.+\..+/.test(data.website)) {
        delete data.website;
      }
    }

    // marketing_emails: {} object → extract values as array
    if (
      data.marketing_emails &&
      !Array.isArray(data.marketing_emails) &&
      typeof data.marketing_emails === 'object'
    ) {
      data.marketing_emails = Object.values(data.marketing_emails);
    }

    // tags: ensure array of lowercase trimmed strings
    if (data.tags && Array.isArray(data.tags)) {
      data.tags = data.tags
        .map((t: any) => String(t).toLowerCase().trim())
        .filter(Boolean);
    }

    // categories: keep as string array — will be resolved to
    // ObjectIds during enrichment phase when we have the DB refs.
    // Store under rawCategories so original value is preserved.
    if (data.categories) {
      data.rawCategories = data.categories;
      delete data.categories;
    }

    // industry: same — keep as string for now
    if (data.industry) {
      data.rawIndustry = data.industry;
      delete data.industry;
    }

    return data;
  }

  private transformOutlet(data: any): any {
    data.isFromCrawler = true;
    data.isActive = false;
    data.isDeleted = false;
    data.viewsCount = data.viewsCount ?? 0;
    data.servingRadius = data.servingRadius ?? 60;

    if (data.latitude && data.longitude) {
      data.location = {
        type: 'Point',
        coordinates: [Number(data.longitude), Number(data.latitude)],
      };
    }

    if (data.phone) {
      data.phone = String(data.phone).replace(/[^\d]/g, '');
    }

    return data;
  }

  private transformEvent(data: any): any {
    data.isFromCrawler = true;
    data.status = EventStatus.DRAFTED;
    data.isDisabled = false;
    data.isFree = data.isFree ?? false;
    data.isFamilyFun = data.isFamilyFun ?? false;
    data.notifyFollowers = data.notifyFollowers ?? true;
    data.viewsCount = data.viewsCount ?? 0;
    data.engagementCount = data.engagementCount ?? 0;
    data.totalLikes = data.totalLikes ?? 0;
    data.totalShares = data.totalShares ?? 0;
    data.totalSaved = data.totalSaved ?? 0;
    data.quantityLimit = data.quantityLimit ?? 0;
    data.RSVP = data.RSVP ?? '';
    data.termsApplied = data.termsApplied ?? false;
    data.creatorType = 'BusinessUser';
    data.participants = data.participants ?? [];
    data.responses = data.responses ?? [];
    data.facebookScheduledPostIds = data.facebookScheduledPostIds ?? [];

    if (data.tags && Array.isArray(data.tags)) {
      data.tags = data.tags
        .map((t: any) => String(t).toLowerCase().trim())
        .filter(Boolean);
    }

    return data;
  }

  private applyDefaults(data: any): any {
    data.isFromCrawler = true;
    data.isDeleted = false;
    return data;
  }

  // ── Global cleaners ──────────────────────────────────────

  private removeNullFields(data: any): any {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && value !== undefined && value !== '') {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  private trimStrings(data: any): any {
    const trimmed: any = {};
    for (const [key, value] of Object.entries(data)) {
      trimmed[key] = typeof value === 'string' ? value.trim() : value;
    }
    return trimmed;
  }

  private normalizeArrayFields(data: any): any {
    for (const [key, value] of Object.entries(data)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof Date)
      ) {
        const entries = Object.entries(value as object);
        const looksLikeSet = entries.every(([k, v]) => k === v);
        if (looksLikeSet && entries.length > 0) {
          data[key] = entries.map(([, v]) => v);
        }
      }
    }
    return data;
  }
}
