import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  BusinessStatus,
  BusinessCreatorType,
  ScalabilityFactor,
  OfferStatus,
  VerificationStatus,
  ConnectStatus,
  BusinessStructure,
} from '../../common/enums';
import {
  Hours,
  HoursSchema,
  TimeBracket,
  TimeBracketSchema,
  Duration,
  DurationSchema,
  DaySchedule,
  DayScheduleSchema,
  Schedule,
  ScheduleSchema,
} from '../../common/schemas/shared.schema';

// ─── Sub-schemas ─────────────────────────────────────────────────────────────

@Schema({ _id: false })
export class StripeAccountStatus {
  @Prop({ type: Boolean, default: false })
  charges_enabled: boolean;

  @Prop({ type: Boolean, default: false })
  payouts_enabled: boolean;

  @Prop({ type: Boolean, default: false })
  details_submitted: boolean;

  @Prop({ type: [String], default: [] })
  currently_due: string[];

  @Prop({ type: String, default: null })
  disabled_reason: string | null;

  @Prop({ type: String })
  bank_name: string;

  @Prop({ type: String })
  last4: string;

  @Prop({ type: Date })
  lastUpdatedAt: Date;
}
export const StripeAccountStatusSchema =
  SchemaFactory.createForClass(StripeAccountStatus);

@Schema({ _id: false })
export class QRTemplates {
  @Prop({ type: String })
  flyerPamphletUrl: string;

  @Prop({ type: String })
  tableCounterTentUrl: string;

  @Prop({ type: String })
  posterUrl: string;

  @Prop({ type: String })
  billboardUrl: string;

  @Prop({ type: String })
  stickerUrl: string;

  @Prop({ type: String })
  digitalScreenUrl: string;
}
export const QRTemplatesSchema = SchemaFactory.createForClass(QRTemplates);

@Schema({ _id: false })
export class FacebookPageInfo {
  @Prop({ type: String })
  name: string;

  @Prop({ type: String })
  about: string;

  @Prop({ type: String })
  category: string;

  @Prop({ type: Number })
  followers: number;

  @Prop({ type: String })
  website: string;

  @Prop({ type: String })
  phone: string;

  @Prop({ type: String })
  email: string;

  @Prop({ type: String })
  profilePicture: string;

  @Prop({ type: String })
  coverPhoto: string;
}
export const FacebookPageInfoSchema =
  SchemaFactory.createForClass(FacebookPageInfo);

@Schema({ _id: false })
export class FacebookMetaData {
  @Prop({ type: String })
  pageId: string;

  @Prop({ type: String })
  pageAccessToken: string;

  @Prop({ type: Date })
  tokenExpiresAt: Date;

  @Prop({ type: FacebookPageInfoSchema })
  pageInfo: FacebookPageInfo;
}
export const FacebookMetaDataSchema =
  SchemaFactory.createForClass(FacebookMetaData);

@Schema({ _id: false })
export class SocialMediaTokenDetails {
  @Prop({ type: String })
  value: string;

  @Prop({ type: Date })
  age: Date;
}
export const SocialMediaTokenDetailsSchema =
  SchemaFactory.createForClass(SocialMediaTokenDetails);

// ─── Main Business schema ────────────────────────────────────────────────────

@Schema({ timestamps: true })
export class Business {
  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Boolean, default: false })
  isFromCrawler: boolean;

  @Prop({
    type: Number,
    required: true,
    enum: Object.values(BusinessStatus),
    default: 0,
  })
  status: number;

  @Prop({ type: String, default: null })
  logo: string;

  @Prop({ type: String, default: null })
  logoThumbnail: string;

  @Prop({ type: Boolean, default: false })
  logoUploaded: boolean;

  @Prop({ type: Types.ObjectId, ref: 'Subscription' })
  activeSubscription: Types.ObjectId;

  @Prop({ type: Boolean })
  isRegistered: boolean;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'BusinessCategory' }] })
  businessCategories: Types.ObjectId[];

  @Prop({ type: Types.ObjectId, ref: 'BusinessIndustry' })
  businessIndustry: Types.ObjectId;

  @Prop({ type: String, default: null })
  cover: string;

  @Prop({ type: String, default: null })
  coverThumbnail: string;

  @Prop({ type: String })
  vehicleType: string;

  @Prop({ type: Types.ObjectId, ref: 'BusinessConstitution' })
  constitution: Types.ObjectId;

  @Prop({ type: String })
  documentNumber: string;

  @Prop({ type: String })
  description: string;

  @Prop({ type: Types.ObjectId, ref: 'BusinessDocumentType' })
  documentType: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Brand' })
  brand: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'BusinessUser' })
  authorisedUser: Types.ObjectId;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'BusinessUser' }] })
  boardMembers: Types.ObjectId[];

  @Prop({
    type: String,
    enum: Object.values(BusinessCreatorType),
    required: true,
  })
  creatorType: string;

  @Prop({ type: Types.ObjectId, required: true, refPath: 'creatorType' })
  creator: Types.ObjectId;

  @Prop({ type: String })
  name: string;

  @Prop({ type: String })
  bio: string;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Outlet' }] })
  outlets: Types.ObjectId[];

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Outlet' }] })
  activatedOutlets: Types.ObjectId[];

  @Prop({ type: Number })
  activatedOutletsLength: number;

  @Prop({ type: String })
  countryCode: string;

  @Prop({ type: String })
  phone: string;

  @Prop({ type: String, unique: true, sparse: true })
  email: string;

  @Prop({ type: Boolean })
  isEmailVerified: boolean;

  @Prop({ type: Boolean })
  isPhoneVerified: boolean;

  @Prop({ type: String })
  website: string;

  @Prop({ type: String })
  addressLine1: string;

  @Prop({ type: String })
  addressLine2: string;

  @Prop({ type: String })
  addressLine3: string;

  @Prop({ type: String })
  city: string;

  @Prop({ type: String })
  locality: string;

  @Prop({ type: String })
  district: string;

  @Prop({ type: String })
  state: string;

  @Prop({ type: Types.ObjectId, ref: 'BusinessCountry' })
  country: Types.ObjectId;

  @Prop({ type: String })
  placeId: string;

  @Prop({ type: ScheduleSchema })
  regularTiming: Schedule;

  @Prop({ type: Boolean, default: false })
  dataFetchedFromGoogle: boolean;

  @Prop({ type: Number })
  latitude: number;

  @Prop({ type: Number })
  longitude: number;

  @Prop({ type: String })
  county: string;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: true })
  isClaimed: boolean;

  @Prop({ type: HoursSchema })
  openingTime: Hours;

  @Prop({ type: HoursSchema })
  closingTime: Hours;

  @Prop({ type: TimeBracketSchema })
  busyTime: TimeBracket;

  @Prop({ type: TimeBracketSchema })
  slowTime: TimeBracket;

  @Prop({ type: String })
  postalCode: string;

  @Prop({ type: Number, default: 0 })
  followersCount: number;

  @Prop({ type: Number, default: 0 })
  followingCount: number;

  @Prop({ type: Number })
  foundationYear: number;

  @Prop({ type: String })
  vatNumber: string;

  @Prop({ type: Number })
  foodHygieneRating: number;

  @Prop({ type: [String] })
  menus: string[];

  @Prop({ type: [Object] })
  allergenInformation: any[];

  @Prop({ type: Boolean })
  acceptsReservations: boolean;

  @Prop({ type: String })
  reservationPolicy: string;

  @Prop({ type: [String] })
  paymentMethods: string[];

  @Prop({ type: [Object] })
  reviews: any[];

  @Prop({ type: [Object] })
  promotions: any[];

  @Prop({ type: [String] })
  covidSafetyMeasures: string[];

  @Prop({ type: Boolean })
  isWheelchairAccessible: boolean;

  @Prop({ type: Boolean })
  isParkingAvailable: boolean;

  @Prop({ type: String })
  sustainabilityEfforts: string;

  @Prop({ type: Object })
  insuranceDetails: any;

  @Prop({ type: Object })
  taxInformation: any;

  @Prop({ type: [String] })
  healthAndSafetyPolicies: string[];

  @Prop({ type: String })
  managerName: string;

  @Prop({ type: String })
  managerEmail: string;

  @Prop({ type: String })
  managerPhone: string;

  @Prop({ type: Types.ObjectId, ref: 'Drive' })
  drive: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Folder' })
  galleryPath: Types.ObjectId;

  @Prop({ type: Boolean, default: false })
  isPhysicalType: boolean;

  @Prop({ type: Number, default: 0 })
  physicalUnits: number;

  @Prop({ type: Boolean, default: false })
  isMobileType: boolean;

  @Prop({ type: Number, default: 0 })
  mobileUnits: number;

  @Prop({ type: Boolean, default: false })
  isOnlineType: boolean;

  @Prop({ type: Number, default: 0 })
  mobileUnitsCreated: number;

  @Prop({ type: Number, default: 0 })
  physicalUnitsCreated: number;

  @Prop({ type: Boolean, default: true })
  continueJourney: boolean;

  @Prop({ type: Number })
  journeyStatus: number;

  @Prop({
    type: { min: { type: Number }, max: { type: Number, default: null } },
    _id: false,
  })
  teamSize: { min: number; max: number | null };

  @Prop({ type: String })
  roleOfCreator: string;

  @Prop({
    type: Number,
    enum: Object.values(OfferStatus),
    default: 0,
  })
  onboardingOfferStatus: number;

  @Prop({ type: Boolean, default: false })
  isOnboardingOfferDone: boolean;

  @Prop({ type: Types.ObjectId, ref: 'Event' })
  initialOfferId: Types.ObjectId;

  @Prop({
    type: Number,
    default: 0,
    enum: Object.values(ScalabilityFactor),
  })
  scalabilityFactor: number;

  @Prop({ type: Number, default: 0 })
  rating: number;

  @Prop({ type: Number, default: 0 })
  userRatingCount: number;

  @Prop({ type: String })
  stripeCustomerId: string;

  @Prop({ type: [String] })
  tags: string[];

  @Prop({ type: [String] })
  addressVerificationDocs: string[];

  @Prop({
    type: String,
    enum: Object.values(VerificationStatus),
    default: VerificationStatus.NOT_VERIFIED,
  })
  verificationStatus: string;

  @Prop({ type: String })
  verificationRemarks: string;

  @Prop({ type: Types.ObjectId, ref: 'Admin' })
  addressVerifiedBy: Types.ObjectId;

  @Prop({ type: String })
  uniqueId: string;

  @Prop({ type: Number, default: 0 })
  profileCompletionPercentage: number;

  @Prop({ type: Number, default: 0 })
  aiTrainingPercentage: number;

  @Prop({ type: String })
  QRCode: string;

  @Prop({ type: String })
  downloadQr: string;

  @Prop({ type: QRTemplatesSchema })
  QRTemplates: QRTemplates;

  @Prop({ type: String })
  appRedirectLink: string;

  @Prop({ type: Boolean, default: false })
  isAgentCreated: boolean;

  @Prop({ type: String })
  aiAgentId: string;

  @Prop({ type: Number, default: 0 })
  viewsCount: number;

  @Prop({ type: String })
  stripeAccountId: string;

  @Prop({ type: String, default: ConnectStatus.NOT_INITIALISED })
  connectStatus: string;

  @Prop({ type: Boolean, default: false })
  stripeOnboardingComplete: boolean;

  @Prop({ type: StripeAccountStatusSchema })
  stripeAccountStatus: StripeAccountStatus;

  @Prop({ type: String, enum: Object.values(BusinessStructure) })
  businessStructure: string;

  @Prop({ type: Boolean, default: false })
  isFacebookConnected: boolean;

  @Prop({ type: FacebookMetaDataSchema })
  facebookMetaData: FacebookMetaData;

  @Prop({ type: Boolean, default: false })
  isInstagramConnected: boolean;

  @Prop({ type: SocialMediaTokenDetailsSchema, default: {} })
  instagramToken: SocialMediaTokenDetails;

  @Prop({ type: String })
  instagramPageUrl: string;

  @Prop({ type: Boolean, default: false })
  isXConnected: boolean;

  @Prop({ type: SocialMediaTokenDetailsSchema, default: {} })
  XToken: SocialMediaTokenDetails;

  @Prop({ type: String })
  XPageUrl: string;

  @Prop({ type: Boolean, default: false })
  isFacebookDatafetched: boolean;

  @Prop({ type: Date })
  lastFacebookDatafetched: Date;

  @Prop({ type: [String] })
  consumerCheckInSuggestions: string[];

  @Prop({ type: Boolean, default: false })
  isBoosted: boolean;

  @Prop({ type: Number, default: 1000 })
  boostOrder: number;

  @Prop({ type: Boolean, default: true })
  showVerificationBanner: boolean;

  @Prop({ type: Boolean, default: false })
  isCvb: boolean;

  @Prop({ type: [String] })
  marketingEmails: string[];

  @Prop({ type: String })
  scraperSession: string;
}

export type BusinessDocument = Business & Document;
export const BusinessSchema = SchemaFactory.createForClass(Business);

// Pre-save hook: generate uniqueId if not set
BusinessSchema.pre('save', function () {
  if (!this.uniqueId) {
    const namePrefix = (this.name || '')
      .replace(/[^a-zA-Z]/g, '')
      .toUpperCase()
      .padEnd(4, String.fromCharCode(65 + Math.floor(Math.random() * 26)))
      .slice(0, 4);
    const digits = Array.from({ length: 3 }, () =>
      Math.floor(Math.random() * 10),
    ).join('');
    const letters = Array.from({ length: 3 }, () =>
      String.fromCharCode(65 + Math.floor(Math.random() * 26)),
    ).join('');
    this.uniqueId = `${namePrefix}${digits}${letters}`;
  }
});

// Indexes
BusinessSchema.index({ name: 'text', tags: 'text' });
BusinessSchema.index({ isActive: 1 });
