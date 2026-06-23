import axios from 'axios';
import mongoose from 'mongoose';
import {
  SeedingModules,
  SeedingErrorMessages,
  ValidationSeverity,
  GooglePlacesConfig,
} from '../../../common/constants';
import { ValidationError } from './validation.engine';

// Schemaless + timestamped. Enrichment is mostly read-only, but it can
// upsert industry/category docs in the target DB; timestamps:true keeps
// those parity with the rest of the target collections.
const LOOSE_SCHEMA = new mongoose.Schema<any>({}, { strict: false, timestamps: true });

export class EnrichmentEngine {
  constructor(
    private readonly targetConnection: mongoose.Connection,
    private readonly pinntagApiUrl: string,
    private readonly pinntagApiToken: string,
    private readonly pinntagBusinessUserEmail: string,
  ) {}

  async enrich(
    module: string,
    transformedData: any,
  ): Promise<{ data: any; warnings: ValidationError[] }> {
    // Deep clone to detach from Mongoose document — without this,
    // dynamically added fields (rating, regularTiming, etc.) are
    // silently dropped when Mongoose serializes the object back.
    const data = JSON.parse(JSON.stringify(transformedData));

    switch (module) {
      case SeedingModules.BUSINESS:
        return this.enrichBusiness(data);
      default:
        return { data, warnings: [] };
    }
  }

  // ── Business enrichment ─────────────────────────────────────────────────────

  private async enrichBusiness(
    data: any,
  ): Promise<{ data: any; warnings: ValidationError[] }> {
    const warnings: ValidationError[] = [];

    // 1. Duplicate check first
    const dupWarnings = await this.checkDuplicateBusiness(data);
    warnings.push(...dupWarnings);
    const hasBlockingDuplicate = dupWarnings.some(
      (w) => w.severity === ValidationSeverity.ERROR,
    );
    if (hasBlockingDuplicate) {
      return { data, warnings };
    }

    // 2. Fetch place data via PinnTag API — skip if scraper already
    //    provided location + rating (means Google data is already present)
    const hasGoogleData =
      data.latitude &&
      data.longitude &&
      data.rating !== undefined;

    if (!hasGoogleData) {
      const placeData = await this.fetchPlaceData(
        data.address1 || data.name,
      );

      if (!placeData) {
        warnings.push({
          field: 'address1',
          message: SeedingErrorMessages.googlePlaceNotFound(
            data.address1 || data.name,
          ),
          severity: ValidationSeverity.WARNING,
        });
      } else {
        data.placeId = placeData.placeId;
        data.addressLine1 = placeData.address1 || data.addressLine1;
        data.addressLine2 = placeData.address2 || '';
        data.city = placeData.city;
        data.state = placeData.state;
        data.country = placeData.country;
        data.postalCode = placeData.postalCode;
        data.locality = placeData.locality || '';
        data.latitude = placeData.latitude;
        data.longitude = placeData.longitude;
        data.dataFetchedFromGoogle = true;

        if (placeData.latitude && placeData.longitude) {
          data.location = {
            type: 'Point',
            coordinates: [
              Number(placeData.longitude),
              Number(placeData.latitude),
            ],
          };
        }
        if (placeData.rating !== undefined && placeData.rating !== null) {
          data.rating = placeData.rating;
        }
        if (placeData.userRatingCount !== undefined) {
          data.userRatingCount = placeData.userRatingCount;
        }
        if (placeData.regularTiming) {
          data.regularTiming = placeData.regularTiming;
        }
      }
    } else {
      if (!data.location && data.latitude && data.longitude) {
        data.location = {
          type: 'Point',
          coordinates: [Number(data.longitude), Number(data.latitude)],
        };
      }
      data.dataFetchedFromGoogle = true;
    }

    // 3. Category resolution — string[] → ObjectId[]
    if (data.rawCategories && data.rawCategories.length > 0) {
      const catResult = await this.resolveCategories(data.rawCategories);
      if (catResult.missing.length > 0) {
        warnings.push({
          field: 'categories',
          message: SeedingErrorMessages.categoryNotFound(catResult.missing),
          severity: ValidationSeverity.WARNING,
        });
      }
      if (catResult.ids.length > 0) {
        data.businessCategories = catResult.ids;
      }
      delete data.rawCategories;
    }

    // 4. Industry resolution — string → ObjectId
    if (data.rawIndustry) {
      const industryId = await this.resolveIndustry(data.rawIndustry);
      if (!industryId) {
        warnings.push({
          field: 'industry',
          message: SeedingErrorMessages.industryNotFound(data.rawIndustry),
          severity: ValidationSeverity.WARNING,
        });
      } else {
        data.businessIndustry = industryId;
      }
      delete data.rawIndustry;
    }

    // 5. Authorised user resolution
    const authorisedUserId = await this.resolveAuthorisedUser();
    if (!authorisedUserId) {
      warnings.push({
        field: 'authorisedUser',
        message: SeedingErrorMessages.businessUserNotFound(
          this.pinntagBusinessUserEmail,
        ),
        severity: ValidationSeverity.WARNING,
      });
    } else {
      data.authorisedUser = authorisedUserId;
    }

    return { data, warnings };
  }

  // ── Google Places — Autocomplete to resolve placeId ─────────────────────────

  private async resolveGooglePlace(
    address: string,
  ): Promise<{ success: boolean; placeId?: string }> {
    try {
      const requestBody = {
        input: address,
        locationBias: {
          circle: {
            center: {
              latitude: GooglePlacesConfig.DEFAULT_LATITUDE,
              longitude: GooglePlacesConfig.DEFAULT_LONGITUDE,
            },
            radius: GooglePlacesConfig.LOCATION_BIAS_RADIUS,
          },
        },
      };

      const response = await axios.post(
        GooglePlacesConfig.AUTOCOMPLETE_URL,
        requestBody,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': this.pinntagApiToken,
            'X-Goog-FieldMask': GooglePlacesConfig.AUTOCOMPLETE_FIELD_MASK,
          },
        },
      );

      const suggestions = response?.data?.suggestions;

      if (!suggestions || suggestions.length === 0) {
        return { success: false };
      }

      const placeId = suggestions[0].placePrediction.placeId;
      return { success: true, placeId };
    } catch {
      return { success: false };
    }
  }

  // ── Fetch place data via PinnTag API ────────────────────────────────────────

  private async fetchPlaceData(address: string): Promise<{
    placeId?: string;
    address1?: string;
    address2?: string;
    city?: string;
    state?: string;
    country?: string;
    postalCode?: string;
    locality?: string;
    latitude?: number;
    longitude?: number;
    rating?: number;
    userRatingCount?: number;
    regularTiming?: any;
    dataFetchedFromGoogle?: boolean;
  } | null> {
    try {
      // Step 1: Autocomplete to resolve placeId (still uses Google directly)
      const placeResult = await this.resolveGooglePlace(address);
      if (!placeResult.success || !placeResult.placeId) return null;

      // Step 2: Get full details via PinnTag API
      const response = await axios.post(
        `${this.pinntagApiUrl}/v1/google/placeDetails`,
        { placeId: placeResult.placeId },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.pinntagApiToken}`,
          },
          timeout: 10000,
        },
      );

      if (!response.data?.data) return null;

      const d = response.data.data;
      return {
        placeId: placeResult.placeId,
        address1: d.address1,
        address2: d.address2,
        city: d.city,
        state: d.state,
        country: d.country,
        postalCode: d.postalCode,
        locality: d.locality,
        latitude: d.latitude,
        longitude: d.longitude,
        rating: d.rating,
        userRatingCount: d.userRatingCount,
        regularTiming: d.regularTiming,
        dataFetchedFromGoogle: true,
      };
    } catch {
      return null;
    }
  }

  // ── Category resolution ─────────────────────────────────────────────────────

  private async resolveCategories(
    names: string[],
  ): Promise<{ ids: mongoose.Types.ObjectId[]; missing: string[] }> {
    try {
      const trimmed = names.map((n) => String(n).trim());
      const BusinessCategoryModel =
        this.targetConnection.models['BusinessCategory'] ||
        this.targetConnection.model('BusinessCategory', LOOSE_SCHEMA);

      const found = await BusinessCategoryModel.find({
        title: { $in: trimmed },
      })
        .select('_id title')
        .lean();

      const foundTitles = found.map((c: any) => c.title);
      const missing = trimmed.filter((t) => !foundTitles.includes(t));
      const ids = found.map((c: any) => c._id);

      return { ids, missing };
    } catch {
      return { ids: [], missing: names };
    }
  }

  // ── Industry resolution ─────────────────────────────────────────────────────

  private async resolveIndustry(
    name: string,
  ): Promise<mongoose.Types.ObjectId | null> {
    try {
      const BusinessIndustryModel =
        this.targetConnection.models['BusinessIndustry'] ||
        this.targetConnection.model('BusinessIndustry', LOOSE_SCHEMA);

      const found = await BusinessIndustryModel.findOne({
        title: String(name).trim(),
      })
        .select('_id')
        .lean();

      return found ? (found as any)._id : null;
    } catch {
      return null;
    }
  }

  // ── Authorised user resolution ──────────────────────────────────────────────

  private async resolveAuthorisedUser(): Promise<mongoose.Types.ObjectId | null> {
    try {
      const BusinessUserModel =
        this.targetConnection.models['BusinessUser'] ||
        this.targetConnection.model('BusinessUser', LOOSE_SCHEMA);

      const found = await BusinessUserModel.findOne({
        email: this.pinntagBusinessUserEmail,
      })
        .select('_id')
        .lean();

      return found ? (found as any)._id : null;
    } catch {
      return null;
    }
  }

  // ── Duplicate check ─────────────────────────────────────────────────────────

  private async checkDuplicateBusiness(data: any): Promise<ValidationError[]> {
    const warnings: ValidationError[] = [];
    const orConditions: any[] = [];

    if (data.email) orConditions.push({ email: data.email });
    if (data.name) orConditions.push({ name: data.name });
    if (data.phone) orConditions.push({ phone: data.phone });

    if (orConditions.length === 0) return warnings;

    try {
      const BusinessModel =
        this.targetConnection.models['Business'] ||
        this.targetConnection.model('Business', LOOSE_SCHEMA);

      const existing = (await BusinessModel.findOne({ $or: orConditions })
        .select('name email phone')
        .lean()) as any;
      if (!existing) return warnings;

      if (existing.name === data.name) {
        warnings.push({
          field: 'name',
          message: SeedingErrorMessages.duplicateBusiness('name', data.name),
          severity: ValidationSeverity.ERROR,
        });
      }
      if (existing.email && existing.email === data.email) {
        warnings.push({
          field: 'email',
          message: SeedingErrorMessages.duplicateBusiness('email', data.email),
          severity: ValidationSeverity.WARNING,
        });
      }
      if (existing.phone && existing.phone === data.phone) {
        warnings.push({
          field: 'phone',
          message: SeedingErrorMessages.duplicateBusiness('phone', data.phone),
          severity: ValidationSeverity.WARNING,
        });
      }
    } catch {
      warnings.push({
        field: 'duplicate_check',
        message: 'Could not verify duplicates against target DB',
        severity: ValidationSeverity.INFO,
      });
    }

    return warnings;
  }
}
