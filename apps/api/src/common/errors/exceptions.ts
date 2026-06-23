import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';

export const Exceptions = {
  // ── Validation ──────────────────────────────────────────

  invalidObjectId: (field: string, value: string) =>
    new AppException({
      code: ErrorCode.INVALID_OBJECT_ID,
      message: `"${value}" is not a valid MongoDB ObjectId`,
      field,
      details: { received: value, expected: '24-character hex string' },
    }),

  missingRequiredField: (field: string) =>
    new AppException({
      code: ErrorCode.MISSING_REQUIRED_FIELD,
      message: `${field} is required`,
      field,
    }),

  invalidEnumValue: (field: string, received: any, allowed: string[]) =>
    new AppException({
      code: ErrorCode.INVALID_ENUM_VALUE,
      message: `"${received}" is not a valid value for ${field}`,
      field,
      details: { received, allowed },
    }),

  invalidDateFormat: (field: string, received: any) =>
    new AppException({
      code: ErrorCode.INVALID_DATE_FORMAT,
      message: `"${received}" is not a valid date for ${field}`,
      field,
      details: { received, expected: 'ISO 8601 date string' },
    }),

  invalidArrayFormat: (field: string) =>
    new AppException({
      code: ErrorCode.INVALID_ARRAY_FORMAT,
      message: `${field} must be an array`,
      field,
      details: { tip: 'Use [] not {}' },
    }),

  valueOutOfRange: (
    field: string,
    received: any,
    min: number,
    max: number,
  ) =>
    new AppException({
      code: ErrorCode.VALUE_OUT_OF_RANGE,
      message: `${field} value ${received} is out of range`,
      field,
      details: { received, min, max },
    }),

  validationFailed: (errors: { field: string; message: string }[]) =>
    new AppException({
      code: ErrorCode.VALIDATION_FAILED,
      message: `Validation failed with ${errors.length} error(s)`,
      details: { errors },
    }),

  invalidJsonBody: (reason: string) =>
    new AppException({
      code: ErrorCode.INVALID_JSON_BODY,
      message: `Request body is not valid JSON: ${reason}`,
    }),

  // ── Resource ────────────────────────────────────────────

  notFound: (resource: string, identifier: string) =>
    new AppException({
      code: ErrorCode.RESOURCE_NOT_FOUND,
      message: `${resource} not found: ${identifier}`,
      details: { resource, identifier },
    }),

  alreadyExists: (resource: string, field: string, value: string) =>
    new AppException({
      code: ErrorCode.RESOURCE_ALREADY_EXISTS,
      message: `${resource} already exists with ${field}: ${value}`,
      details: { resource, field, value },
    }),

  // ── Seeding Pipeline ────────────────────────────────────

  sessionNotFound: (id: string) =>
    new AppException({
      code: ErrorCode.SESSION_NOT_FOUND,
      message: `Seeding session not found: ${id}`,
      details: { sessionId: id },
    }),

  recordNotFound: (id: string) =>
    new AppException({
      code: ErrorCode.RECORD_NOT_FOUND,
      message: `Seeding record not found: ${id}`,
      details: { recordId: id },
    }),

  sessionNotReady: (currentStatus: string, requiredStatus: string) =>
    new AppException({
      code: ErrorCode.SESSION_NOT_READY,
      message: `Session is in "${currentStatus}" status — must be "${requiredStatus}" to proceed`,
      details: { currentStatus, requiredStatus },
    }),

  invalidPipelineStage: (attempted: string, currentStatus: string) =>
    new AppException({
      code: ErrorCode.INVALID_PIPELINE_STAGE,
      message: `Cannot run "${attempted}" — session is currently "${currentStatus}"`,
      details: { attempted, currentStatus },
    }),

  publishTargetMissing: (environment: string) =>
    new AppException({
      code: ErrorCode.PUBLISH_TARGET_MISSING,
      message: `No target database URI configured for environment: ${environment}`,
      details: { environment },
    }),

  duplicateBusiness: (field: string, value: string) =>
    new AppException({
      code: ErrorCode.DUPLICATE_BUSINESS,
      message: `Business already exists with ${field}: ${value}`,
      field,
      details: { field, value },
    }),

  // ── Database ────────────────────────────────────────────

  dbCastError: (field: string, value: any, targetType: string) =>
    new AppException({
      code: ErrorCode.DB_CAST_ERROR,
      message: `Cannot cast "${value}" to ${targetType} for field "${field}"`,
      field,
      details: { received: value, expectedType: targetType },
    }),

  dbDuplicateKey: (field: string, value: any) =>
    new AppException({
      code: ErrorCode.DB_DUPLICATE_KEY,
      message: `Duplicate value "${value}" for unique field "${field}"`,
      field,
      details: { field, value },
    }),

  dbValidationError: (errors: Record<string, string>) =>
    new AppException({
      code: ErrorCode.DB_VALIDATION_ERROR,
      message: 'Database validation failed',
      details: { errors },
    }),

  // ── External Services ───────────────────────────────────

  googleApiFailed: (reason: string) =>
    new AppException({
      code: ErrorCode.GOOGLE_API_FAILED,
      message: `Google Places API error: ${reason}`,
      details: { service: 'Google Places API v1' },
    }),

  googlePlaceNotFound: (address: string) =>
    new AppException({
      code: ErrorCode.GOOGLE_PLACE_NOT_FOUND,
      message: `No Google Place found for: "${address}"`,
      details: { address },
    }),

  pythonBotUnreachable: (url: string) =>
    new AppException({
      code: ErrorCode.PYTHON_BOT_UNREACHABLE,
      message: `Python bot is unreachable at: ${url}`,
      details: { url },
    }),

  // ── Auth ────────────────────────────────────────────────

  invalidAdminPassword: () =>
    new AppException({
      code: ErrorCode.INVALID_ADMIN_PASSWORD,
      message: 'Invalid admin password',
    }),

  // ── Server ──────────────────────────────────────────────

  internal: (context: string, cause?: unknown) =>
    new AppException({
      code: ErrorCode.INTERNAL_ERROR,
      message: `Internal error in ${context}`,
      details: { context },
      cause,
    }),
};
