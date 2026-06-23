import mongoose from 'mongoose';
import {
  BusinessStatus,
  ConnectStatus,
  DEFAULT_IMAGES,
  VerificationStatus,
  BusinessCreatorType,
} from '../../../common/enums';
import { fullStateName } from '../common/us-states';

// ─────────────────────────────────────────────────────────────────────────────
// Constants below are byte-for-byte mirrored from the PinnTag main backend
// (BusinessStatus, ProfileCompletionStatus, ConnectStatus, etc.). If those
// values drift, DOP-seeded businesses silently lose parity with claim-time
// docs. Update both repos together.
// ─────────────────────────────────────────────────────────────────────────────

export const SEED_DEFAULT_LOGO = DEFAULT_IMAGES.BUSINESS_LOGO;
export const SEED_DEFAULT_COVER = DEFAULT_IMAGES.BUSINESS_COVER;

// Bumped whenever the parity contract changes. dopSyncState rows pin the
// version they were synced under; a bump invalidates every existing row and
// forces a re-sync on the next applySync run.
export const DOP_SYNC_VERSION = 1;

// Fields that may NEVER be overwritten by a sync if they already hold a
// real value. Bot/enrichment-set content + identity-bearing fields.
export const DOP_SYNC_PROTECTED_FIELDS = [
  'logo',
  'logoThumbnail',
  'cover',
  'coverThumbnail',
  'rating',
  'userRatingCount',
  'uniqueId',
  'appRedirectLink',
  'placeId',
] as const;

export const SEED_BUSINESS_STATUS_COVER_ADDED = BusinessStatus.COVER_ADDED; // 4
export const SEED_PROFILE_COMPLETION_LOGO = 200;
export const SEED_PROFILE_COMPLETION_PERCENTAGE = 20;
export const SEED_CREATOR_TYPE_ADMIN = BusinessCreatorType.ADMIN;
export const SEED_CONNECT_STATUS = ConnectStatus.NOT_INITIALISED;
export const SEED_TEMPLATE_STATUS = 'not initialised';
export const SEED_VERIFICATION_STATUS = VerificationStatus.NOT_VERIFIED;

const randDigits = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const randLetters = (n: number) =>
  Array.from({ length: n }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  ).join('');

// Mirrors Business pre-save hook in PinnTag main backend.
export function generateUniqueId(name: string): string {
  const upper = (name || '').replace(/[^A-Z]/gi, '').toUpperCase();
  const prefix =
    upper.length >= 4
      ? upper.substring(0, 4)
      : upper + randLetters(4 - upper.length);
  return `${prefix}${randDigits(3)}${randLetters(3)}`;
}

const EMPTY = () => [] as string[];

export const BUSINESS_FILTER_ARRAY_KEYS = [
  'accessibility', 'cuisine', 'dietaryOptions', 'mealType', 'diningOptions',
  'barFeatures', 'entertainmentType', 'musicGenre', 'serviceType',
  'targetAudience', 'classType', 'skillLevel', 'ageGroup', 'activityType',
  'experienceType', 'groupType', 'attractionType', 'shoppingType',
  'productStyle', 'serviceMode', 'availability', 'trustSignals', 'stayType',
  'guestType', 'propertyAmenities',
] as const;

export const OUTLET_FILTER_ARRAY_KEYS = [
  'accessibility', 'paymentMethods', 'cuisine', 'dietaryOptions', 'mealType',
  'diningOptions', 'barFeatures', 'entertainmentType', 'musicGenre',
  'serviceType', 'targetAudience', 'classType', 'skillLevel', 'ageGroup',
  'activityType', 'experienceType', 'groupType', 'attractionType',
  'shoppingType', 'productStyle', 'serviceMode', 'availability',
  'trustSignals', 'stayType', 'guestType', 'propertyAmenities',
] as const;

// Mongoose-managed fields stripped from any merge output that will be used
// in $set or as the source for a re-insert.
export const SEED_STRIP_MANAGED_FIELDS = [
  '_id', '__v', 'createdAt', 'updatedAt',
] as const;

export function stripManagedFields(doc: Record<string, any>): void {
  for (const k of SEED_STRIP_MANAGED_FIELDS) delete doc[k];
}

/**
 * Canonical Business field set for a seeded business. `base` is the
 * transformed/enriched doc DOP already has. Explicit values here override
 * schema defaults that a strict:false model will not apply.
 */
export function buildSeededBusinessFields(
  base: Record<string, any>,
  systemUserId: mongoose.Types.ObjectId,
  opts: { hasBotCover?: boolean } = {},
): Record<string, any> {
  const filters = Object.fromEntries(
    BUSINESS_FILTER_ARRAY_KEYS.map((k) => [k, base[k] ?? EMPTY()]),
  );

  return {
    ...base,

    creatorType: SEED_CREATOR_TYPE_ADMIN,
    creator: systemUserId,
    authorisedUser: systemUserId,
    isClaimed: false,

    status: SEED_BUSINESS_STATUS_COVER_ADDED,
    isFromCrawler: true,
    dataFetchedFromGoogle: true,
    isActive: base.isActive ?? true,
    isDeleted: false,
    verificationStatus: base.verificationStatus ?? SEED_VERIFICATION_STATUS,
    showVerificationBanner: true,
    isCvb: base.isCvb ?? false,

    logo: base.logo ?? SEED_DEFAULT_LOGO,
    logoThumbnail: base.logoThumbnail ?? SEED_DEFAULT_LOGO,
    logoUploaded: base.logoUploaded ?? false,
    cover: opts.hasBotCover ? base.cover : (base.cover ?? SEED_DEFAULT_COVER),
    coverThumbnail: opts.hasBotCover
      ? base.coverThumbnail
      : (base.coverThumbnail ?? SEED_DEFAULT_COVER),

    profileCompletionStatus: SEED_PROFILE_COMPLETION_LOGO,
    profileCompletionPercentage: SEED_PROFILE_COMPLETION_PERCENTAGE,
    completedProfileSteps: base.completedProfileSteps ?? [],
    completedQuestionnaireSteps: 0,
    totalQuestionnaireSteps: 0,
    aiTrainingPercentage: 0,

    followersCount: 0,
    followingCount: 0,
    viewsCount: 0,
    rating: base.rating ?? 0,
    userRatingCount: base.userRatingCount ?? 0,

    continueJourney: true,
    onboardingOfferStatus: 0,
    isOnboardingOfferDone: false,
    scalabilityFactor: base.scalabilityFactor ?? 0,

    isPhysicalType: base.isPhysicalType ?? false,
    physicalUnits: base.physicalUnits ?? 0,
    isMobileType: base.isMobileType ?? false,
    mobileUnits: base.mobileUnits ?? 0,
    isOnlineType: base.isOnlineType ?? false,

    connectStatus: SEED_CONNECT_STATUS,
    stripeOnboardingComplete: false,
    templateGenerationStatus: SEED_TEMPLATE_STATUS,
    isAgentCreated: false,
    isFacebookConnected: false,
    isInstagramConnected: false,
    isXConnected: false,
    isFacebookDatafetched: false,
    isBoosted: false,
    boostOrder: 1000,

    isEmailVerified: false,
    isPhoneVerified: false,

    // Deferred to claim flow — explicitly NOT set here:
    // QRCode, referralCodeDynamicLink, stripeAccountId, aiAgentId,
    // consumerCheckInSuggestions, appRedirectLink (no short-link service
    // wired into DOP API yet — see STEP 4 in the task brief).

    ...filters,

    uniqueId: base.uniqueId ?? generateUniqueId(base.name),
  };
}

/**
 * Canonical Outlet field set. lng/lat are REQUIRED — without them the
 * outlet is invisible to consumer $geoNear discovery.
 */
export function buildSeededOutletFields(
  base: Record<string, any>,
  args: {
    businessId: mongoose.Types.ObjectId;
    creatorId: mongoose.Types.ObjectId;
    category: string;
    longitude: number;
    latitude: number;
    drivePath?: mongoose.Types.ObjectId;
    galleryPath?: mongoose.Types.ObjectId;
  },
): Record<string, any> {
  const filters = Object.fromEntries(
    OUTLET_FILTER_ARRAY_KEYS.map((k) => [k, base[k] ?? EMPTY()]),
  );

  return {
    ...base,
    business: args.businessId,
    creator: args.creatorId,
    category: args.category,
    isActive: true,
    isFromCrawler: true,
    isDeleted: false,
    servingRadius: base.servingRadius ?? 60,
    viewsCount: 0,
    rating: base.rating ?? 0,
    userRatingCount: base.userRatingCount ?? 0,
    spots: [],
    postalCode: base.postalCode ?? base.zip,
    drivePath: args.drivePath,
    galleryPath: args.galleryPath,
    location: {
      type: 'Point',
      coordinates: [args.longitude, args.latitude],
    },
    latitude: args.latitude,
    longitude: args.longitude,
    ...filters,
  };
}

/**
 * Address/contact base for an outlet, derived from a business doc.
 * Mirrors the inline block inside PostPublishService.activateBusiness so
 * any code path that creates an outlet for an existing business (initial
 * activation, missing-outlet repair) produces an identical document.
 *
 * Includes the address1-comma-split fallback used when addressLine1 is
 * missing but the legacy address1 field carries a "street, city, ST zip"
 * string.
 */
export function buildOutletBaseFromBusiness(
  business: Record<string, any>,
): Record<string, any> {
  const outletBase: Record<string, any> = {
    name: business.name,
    address1: business.addressLine1 || business.address1 || '',
    address2: business.addressLine2 || business.address2 || '',
    city: business.city || '',
    state: fullStateName(business.state || ''),
    zip: business.postalCode || business.zip || '',
    country: business.country,
    countryCode: business.countryCode,
    phone: business.phone,
    email: business.email,
    locality: business.locality,
    website: business.website,
  };

  if (!outletBase.address1 && business.address1) {
    const parts = String(business.address1)
      .split(',')
      .map((p: string) => p.trim());
    if (parts.length >= 3) {
      outletBase.address1 = parts[0];
      if (!outletBase.city) outletBase.city = parts[1];
      const stateZip = (parts[2] || '').trim().split(' ');
      if (!outletBase.state) {
        outletBase.state = fullStateName(stateZip[0] || '');
      }
      if (!outletBase.zip) outletBase.zip = stateZip[1] || '';
    }
  }

  return outletBase;
}

export function buildSeededCreditWallet(
  businessId: mongoose.Types.ObjectId,
): Record<string, any> {
  return {
    business: businessId,
    credits: 0,
    totalCredits: 100,
    creditsRenewalDate: new Date(),
    status: 'active',
  };
}

/**
 * True when bot has already replaced the cover with a real (B2-hosted or
 * non-googleusercontent) image. Used to prevent buildSeededBusinessFields
 * from clobbering a real cover with the default cover.
 */
export function hasRealBotCover(business: Record<string, any>): boolean {
  const cover = business.cover;
  if (!cover || typeof cover !== 'string') return false;
  if (cover === SEED_DEFAULT_COVER) return false;
  if (cover.includes('googleusercontent')) return false;
  return true;
}
