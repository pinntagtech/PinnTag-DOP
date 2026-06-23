export const ValidationMessages = {
  required: (field: string) => `${field} is required`,
  minLength: (field: string, min: number) =>
    `${field} must be at least ${min} characters`,
  invalidEnum: (field: string, allowed: string[]) =>
    `${field} must be one of: ${allowed.join(', ')}`,
  invalidEmail: (field: string) =>
    `${field} is not a valid email address`,
  invalidLatitude: () =>
    `latitude must be a number between -90 and 90`,
  invalidLongitude: () =>
    `longitude must be a number between -180 and 180`,
  invalidPhone: (field: string) =>
    `${field} must be a non-empty string`,
  invalidUrl: (field: string) =>
    `${field} is not a valid URL`,
  invalidArrayFormat: (field: string) =>
    `${field} must be an array — received object or invalid format`,
  nullCoerced: (field: string) =>
    `${field} was null and has been removed`,
} as const;

export const ValidationLimits = {
  business: {
    name: { min: 2 },
    description: { max: 2000 },
    phone: { min: 5, max: 20 },
    tags: { maxItems: 30 },
  },
  outlet: {
    name: { min: 2 },
    phone: { min: 5, max: 20 },
  },
  event: {
    title: { min: 3 },
    description: { max: 5000 },
  },
  menu: {
    name: { min: 1 },
  },
} as const;
