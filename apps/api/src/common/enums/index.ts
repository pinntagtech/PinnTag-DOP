// ─────────────────────────────────────────────────────────────────────────────
// DATA CONTRACT RULE: All values here must be byte-for-byte identical to the
// original PinnTag codebase. Never rename a key or change a value without
// verifying it against the source. These enums are shared across seeding
// and production — any drift will cause silent data corruption.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Business User ───────────────────────────────────────────────────────────

export const ProfileStatus = {
  INITIATED: 0,
  EMAIL_VERIFIED: 1,
} as const;

export const BusinessUserCreatorType = {
  ADMIN: 'Admin',
  BUSINESS: 'Business',
  SYSTEM: 'System',
  SELF: 'Self',
} as const;

// ─── Business ────────────────────────────────────────────────────────────────

export const BusinessStatus = {
  CREATED: 0,
  VERIFIED: 1,
  SUBSCRIPTION: 1.5,
  ADDRESS_ADDED: 2,
  TAGS_DESCRIPTION_ADDED: 3,
  COVER_ADDED: 4,
  CONFETTI_SCREEN: 4.1,
  CONTENT_CREATION_START: 4.2,
} as const;

export const BusinessCreatorType = {
  ADMIN: 'Admin',
  BUSINESS_USER: 'BusinessUser',
} as const;

export const ScalabilityFactor = {
  SINGLE: 0,
  MULTIBRAND: 1,
  CHARITY: 2,
  MOBILE_ONLY: 3,
} as const;

export const OfferStatus = {
  DEFAULT: 0,
  CREATED: 1,
  SCHEDULE: 2,
  LOCATIONS: 3,
  PUBLISHED: 4,
} as const;

export const VerificationStatus = {
  NOT_VERIFIED: 'not verified',
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
} as const;

export const ConnectStatus = {
  NOT_INITIALISED: 'not initialised',
  ONBOARDED: 'onboarded',
  PENDING: 'pending',
  REJECTED: 'rejected',
} as const;

export const BusinessStructure = {
  INDIVIDUAL: 'individual',
  COMPANY: 'company',
} as const;

export const OwnershipTransferStatus = {
  INITIATED: 0,
  IN_PROGRESS: 1,
  COMPLETED: 2,
  CANCELLED: 3,
} as const;

// ─── Outlet ──────────────────────────────────────────────────────────────────

export enum OutletCategoryList {
  PHYSICAL = 'Physical',
  MOBILE = 'Mobile',
}

export enum VehicleType {
  TRUCK = 'Truck',
  VAN = 'Van',
  POPUP = 'Pop-up',
  KIOSK = 'Kiosk',
}

export const OutletTypes = {
  RESTAURANT: 'RESTAURANT',
  KIOSK: 'KIOSK',
  CAFE: 'CAFE',
  BAR: 'BAR',
  PUB: 'PUB',
  CLUB: 'CLUB',
  LOUNGE: 'LOUNGE',
  BAKERY: 'BAKERY',
  CONFECTIONERY: 'CONFECTIONERY',
  ICE_CREAM_PARLOUR: 'ICE_CREAM_PARLOUR',
  JUICE_BAR: 'JUICE_BAR',
  FOOD_TRUCK: 'FOOD_TRUCK',
  FOOD_STALL: 'FOOD_STALL',
  FOOD_CART: 'FOOD_CART',
  FOOD_COURT: 'FOOD_COURT',
  VENDING_MACHINE: 'VENDING_MACHINE',
  CUSTOMER_SERVICE: 'CUSTOMER_SERVICE',
  ONLINE: 'ONLINE',
  PHYSICAL_STORE: 'PHYSICAL_STORE',
  HOME_BASED: 'HOME_BASED',
  MOBILE: 'MOBILE',
  POP_UP: 'POP_UP',
  CLOUD_KITCHEN: 'CLOUD_KITCHEN',
  DARK_KITCHEN: 'DARK_KITCHEN',
  COMMISSION_OUTLET: 'COMMISSION_OUTLET',
  DISTRIBUTION_OUTLET: 'DISTRIBUTION_OUTLET',
  FRANCHISE_OUTLET: 'FRANCHISE_OUTLET',
  WAREHOUSE: 'WAREHOUSE',
  OTHER: 'OTHER',
} as const;

// ─── Event ───────────────────────────────────────────────────────────────────

export enum EventTypes {
  FORMAL = 'business_event',
  OFFER = 'offer',
  PRIVATE = 'private',
  FLASHDEAL = 'flashdeal',
  SPOTLIGHT = 'spotlight',
  DROPPED_PIN = 'dropped_pin',
}

export enum EventStatus {
  DRAFTED = 'drafted',
  PUBLISHED = 'published',
  CLOSED = 'closed',
  BLOCKED = 'blocked',
}

export enum DiscountType {
  Percentage = '% Off',
  Flat = '$ Off',
  BOGO = 'BOGO',
  FREE_ITEM = 'Free Item',
  BUNDLE = 'Combo/Bundle',
  HAPPY_HOUR = 'Happy Hour',
  FAMILY_FUN = 'Family Fun',
  CUSTOM = 'Custom Deal',
}

export const RedemptionLimit = {
  UNLIMITED: 'unlimited',
  ONCE_A_MONTH: 'ONCE A MONTH',
  ONLY_ONCE: 'ONLY ONCE',
  ONCE_A_WEEK: 'ONCE A WEEK',
  ONCE_A_DAY: 'ONCE A DAY',
} as const;

export const RSVPTypes = {
  GOING: 'going',
  MAYBE: 'maybe',
  NOT_GOING: 'not_going',
} as const;

export const CONTENT_TYPE_MAP = {
  Offer: EventTypes.OFFER,
  Event: EventTypes.FORMAL,
  Spotlight: EventTypes.SPOTLIGHT,
} as const;

// ─── Media / File ────────────────────────────────────────────────────────────

export const FileType = {
  IMAGE: 'image',
  VIDEO: 'video',
  DOCUMENT: 'document',
  GIF: 'gif',
  AUDIO: 'audio',
  OTHER: 'other',
} as const;

export const FileCategoryTypes = {
  PROFILE_PICTURE: 'profile picture',
  THUMBNAIL: 'thumbnail',
  GALLERY_IMAGE: 'gallery image',
  LOGO: 'logo',
  PROMOTIONAL_IMAGE: 'promotional image',
  PROMOTIONAL_VIDEO: 'promotional video',
  BROCHURE: 'brochure',
  LIVE_STREAM_RECORDING: 'live stream recording',
  BUSINESS_LICENSE: 'business license',
  TAX_DOCUMENT: 'tax document',
  ID_PROOF: 'ID Proof',
  INVOICE: 'invoice',
  AUDIO_NOTE: 'Audio Note',
  CONTENT_QR: 'Content QR',
  VERIFICATION_DOCUMENT: 'Verification Document',
  OTHER: 'other',
} as const;

// ─── Subscription ────────────────────────────────────────────────────────────

export enum SubscriptionStatus {
  ACTIVE = 'active',
  TRIAL = 'trial',
  PAST_DUE = 'past_due',
  CANCELED = 'canceled',
  EXPIRED = 'expired',
  PAUSED = 'paused',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
  ON_HOLD = 'on_hold',
  IN_GRACE_PERIOD = 'in_grace_period',
  FULFILLED = 'fulfilled',
  VOIDED = 'voided',
  REVOKED = 'revoked',
}

export enum SubscriptionSource {
  STRIPE = 'stripe',
  APPLE = 'apple',
  GOOGLE = 'google',
  FREE = 'free',
}

// ─── Auth / Users ────────────────────────────────────────────────────────────

export const UserTypes = {
  USER: 'Consumer',
  BUSINESS: 'BusinessUser',
  ADMIN: 'Admin',
  GUEST: 'Guest',
} as const;

export const TokenTypes = {
  ACCESS: 'access',
  REFRESH: 'refresh',
  RESET_PASSWORD: 'resetPassword',
  VERIFY_EMAIL: 'verifyEmail',
  GUEST_USER: 'guestUser',
  FCM: 'fcm',
} as const;

// ─── Documents ───────────────────────────────────────────────────────────────

export const BusinessDocumentTypesList = {
  TAX: 'Tax Document',
  REGISTRATION: 'Registration Document',
  LICENSE: 'Business License',
  OWNERSHIP: 'Proof of Ownership',
  ADDRESS_VERIFICATION: 'Address Verification Document',
  OTHER: 'Other',
} as const;

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_IMAGES = {
  BUSINESS_COVER:
    'https://pinntag-assets.s3.us-east-1.amazonaws.com/Defaults/default+cover.svg',
  BUSINESS_LOGO:
    'https://pinntag-assets.s3.us-east-1.amazonaws.com/Defaults/Default+Business+logo.png',
  BUSINESS_USER:
    'https://pinntag-assets.s3.us-east-1.amazonaws.com/Defaults/Default+business+user.png',
} as const;
