import {
  ValidationMessages,
  ValidationLimits,
  ValidationSeverity,
  SeedingModules,
} from '../../../common/constants';
import { OutletCategoryList, EventTypes } from '../../../common/enums';

export interface ValidationError {
  field: string;
  message: string;
  severity: string;
}

export class ValidationEngine {
  validate(module: string, rawData: any): ValidationError[] {
    switch (module) {
      case SeedingModules.BUSINESS:
        return this.validateBusiness(rawData);
      case SeedingModules.OUTLET:
        return this.validateOutlet(rawData);
      case SeedingModules.EVENT:
        return this.validateEvent(rawData);
      case SeedingModules.MENU:
        return this.validateMenu(rawData);
      default:
        return this.validateGeneric(rawData);
    }
  }

  private validateBusiness(data: any): ValidationError[] {
    const errors: ValidationError[] = [];

    // Required — name
    if (
      !data.name ||
      String(data.name).trim().length < ValidationLimits.business.name.min
    ) {
      errors.push({
        field: 'name',
        message: ValidationMessages.required('name'),
        severity: ValidationSeverity.ERROR,
      });
    }

    // Email — WARNING if present but invalid, INFO if null
    if (
      data.email !== null &&
      data.email !== undefined &&
      data.email !== ''
    ) {
      if (!this.isValidEmail(data.email)) {
        errors.push({
          field: 'email',
          message: ValidationMessages.invalidEmail('email'),
          severity: ValidationSeverity.WARNING,
        });
      }
    }
    if (data.email === null) {
      errors.push({
        field: 'email',
        message: ValidationMessages.nullCoerced('email'),
        severity: ValidationSeverity.INFO,
      });
    }

    // Phone — INFO if missing
    if (!data.phone) {
      errors.push({
        field: 'phone',
        message: ValidationMessages.required('phone'),
        severity: ValidationSeverity.INFO,
      });
    }

    // Geo coordinates — ERROR if present but invalid
    if (data.latitude !== undefined && data.latitude !== null) {
      const lat = Number(data.latitude);
      if (isNaN(lat) || lat < -90 || lat > 90) {
        errors.push({
          field: 'latitude',
          message: ValidationMessages.invalidLatitude(),
          severity: ValidationSeverity.ERROR,
        });
      }
    }
    if (data.longitude !== undefined && data.longitude !== null) {
      const lng = Number(data.longitude);
      if (isNaN(lng) || lng < -180 || lng > 180) {
        errors.push({
          field: 'longitude',
          message: ValidationMessages.invalidLongitude(),
          severity: ValidationSeverity.ERROR,
        });
      }
    }

    // marketing_emails — WARNING if object instead of array
    if (
      data.marketing_emails !== undefined &&
      !Array.isArray(data.marketing_emails)
    ) {
      errors.push({
        field: 'marketing_emails',
        message: ValidationMessages.invalidArrayFormat('marketing_emails'),
        severity: ValidationSeverity.WARNING,
      });
    }

    // categories — INFO if missing
    if (!data.categories || data.categories.length === 0) {
      errors.push({
        field: 'categories',
        message: ValidationMessages.required('categories'),
        severity: ValidationSeverity.INFO,
      });
    }

    // website — WARNING if present but not a valid URL
    if (data.website && !this.isValidUrl(data.website)) {
      errors.push({
        field: 'website',
        message: ValidationMessages.invalidUrl('website'),
        severity: ValidationSeverity.WARNING,
      });
    }

    return errors;
  }

  private validateOutlet(data: any): ValidationError[] {
    const errors: ValidationError[] = [];

    if (
      !data.name ||
      String(data.name).trim().length < ValidationLimits.outlet.name.min
    ) {
      errors.push({
        field: 'name',
        message: ValidationMessages.required('name'),
        severity: ValidationSeverity.ERROR,
      });
    }

    if (!data.business) {
      errors.push({
        field: 'business',
        message: ValidationMessages.required('business'),
        severity: ValidationSeverity.ERROR,
      });
    }

    if (
      data.category &&
      !Object.values(OutletCategoryList).includes(data.category)
    ) {
      errors.push({
        field: 'category',
        message: ValidationMessages.invalidEnum(
          'category',
          Object.values(OutletCategoryList),
        ),
        severity: ValidationSeverity.WARNING,
      });
    }

    if (data.latitude !== undefined && data.latitude !== null) {
      const lat = Number(data.latitude);
      if (isNaN(lat) || lat < -90 || lat > 90) {
        errors.push({
          field: 'latitude',
          message: ValidationMessages.invalidLatitude(),
          severity: ValidationSeverity.ERROR,
        });
      }
    }

    if (data.longitude !== undefined && data.longitude !== null) {
      const lng = Number(data.longitude);
      if (isNaN(lng) || lng < -180 || lng > 180) {
        errors.push({
          field: 'longitude',
          message: ValidationMessages.invalidLongitude(),
          severity: ValidationSeverity.ERROR,
        });
      }
    }

    return errors;
  }

  private validateEvent(data: any): ValidationError[] {
    const errors: ValidationError[] = [];

    if (
      !data.title ||
      String(data.title).trim().length < ValidationLimits.event.title.min
    ) {
      errors.push({
        field: 'title',
        message: ValidationMessages.required('title'),
        severity: ValidationSeverity.ERROR,
      });
    }

    if (!data.type || !Object.values(EventTypes).includes(data.type)) {
      errors.push({
        field: 'type',
        message: ValidationMessages.invalidEnum(
          'type',
          Object.values(EventTypes),
        ),
        severity: ValidationSeverity.ERROR,
      });
    }

    if (!data.businessProfile) {
      errors.push({
        field: 'businessProfile',
        message: ValidationMessages.required('businessProfile'),
        severity: ValidationSeverity.ERROR,
      });
    }

    return errors;
  }

  private validateMenu(data: any): ValidationError[] {
    const errors: ValidationError[] = [];

    if (
      !data.name ||
      String(data.name).trim().length < ValidationLimits.menu.name.min
    ) {
      errors.push({
        field: 'name',
        message: ValidationMessages.required('name'),
        severity: ValidationSeverity.ERROR,
      });
    }

    return errors;
  }

  private validateGeneric(_data: any): ValidationError[] {
    return [];
  }

  // ── Helpers ──────────────────────────────────────────────

  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email));
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
}
