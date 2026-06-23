# PinnTag DOP API — Project Context

> Data Operations Platform for PinnTag. NestJS + MongoDB (Mongoose).
> This document is kept in sync with every structural change.

---

## Quick Reference

| Item              | Value                                      |
| ----------------- | ------------------------------------------ |
| Framework         | NestJS 11                                  |
| Database          | MongoDB via Mongoose 9                     |
| Language          | TypeScript 5, ES2023 target                |
| Default port      | 3000 (`PORT` env var)                      |
| API prefix        | `/api/v1` (`API_PREFIX` env var)           |
| DOP Mongo URI     | `MONGO_URI` (default `localhost:27017/pinntag-dop`) |
| PinnTag Dev URI   | `PINNTAG_DEV_MONGO_URI`                    |
| PinnTag Staging   | `PINNTAG_STAGING_MONGO_URI`                |
| PinnTag Prod URI  | `PINNTAG_PROD_MONGO_URI`                   |
| Google Maps API   | `GOOGLE_MAPS_API_KEY`                      |
| Business User     | `PINNTAG_BUSINESS_USER_EMAIL` (for seeding assignment) |
| Validation        | Global `ValidationPipe` (whitelist, forbidNonWhitelisted, transform) |
| Exception filter  | Global `HttpExceptionFilter`               |
| CORS              | Enabled globally                           |
| HTTP client       | axios                                      |

---

## File Tree

```
src/
├── main.ts                          # Bootstrap, global pipes/filters/CORS
├── app.module.ts                    # Root module — imports all feature modules
├── app.controller.ts                # Root controller
├── app.service.ts                   # Root service
├── app.controller.spec.ts           # Root controller test
│
├── config/
│   ├── app.config.ts                # NODE_ENV, port, apiPrefix
│   └── database.config.ts           # MONGO_URI, PINNTAG_PROD_MONGO_URI
│
├── database/
│   └── database.module.ts           # MongooseModule.forRootAsync
│
├── common/
│   ├── constants/
│   │   ├── index.ts                 # Re-exports all constant modules
│   │   ├── seeding.constants.ts     # Seeding statuses, actions, messages, projections
│   │   ├── validation.constants.ts  # Validation messages, field limits
│   │   ├── google.constants.ts      # Google Places API config, address types, day maps
│   │   ├── business.constants.ts    # Business projections, sort orders
│   │   ├── outlet.constants.ts      # Outlet projections, sort orders
│   │   ├── event.constants.ts       # Event projections, sort orders
│   │   └── media.constants.ts       # Media projections
│   ├── enums/
│   │   └── index.ts                 # All shared enums (data-contract critical)
│   ├── schemas/
│   │   └── shared.schema.ts         # Reusable sub-schemas (see below)
│   ├── exceptions/
│   │   └── http-exception.filter.ts # Global HTTP exception filter
│   ├── decorators/                  # (empty — placeholder)
│   ├── guards/                      # (empty — placeholder)
│   ├── interceptors/                # (empty — placeholder)
│   └── pipes/                       # (empty — placeholder)
│
└── modules/
    ├── business/                    # Standard module
    ├── business-user/               # Standard module
    ├── outlet/                      # Standard module
    ├── event/                       # Standard module
    ├── event-location/              # Standard module
    ├── event-schedule/              # Standard module
    ├── menu/                        # Standard module
    ├── media/                       # Standard module (3 DTOs)
    └── seeding/                     # Pipeline module (non-standard)
```

---

## Standard Module Pattern

Every module except Seeding follows this layout:

```
module-name/
├── module-name.module.ts
├── module-name.schema.ts
├── module-name.controller.ts
├── module-name.service.ts
├── module-name.repository.ts
└── dto/
    └── create-module-name.dto.ts
```

Layers: Controller -> Service -> Repository -> Mongoose Model.

---

## Shared Sub-Schemas (`src/common/schemas/shared.schema.ts`)

Consolidated from duplicates across Business, Outlet, and EventLocation modules.

| Class        | Fields                                | Used by                              |
| ------------ | ------------------------------------- | ------------------------------------ |
| Hours        | hour, minute                          | Business, Outlet                     |
| TimeBracket  | startTime (Hours), endTime (Hours)    | Business                             |
| LocationType | type (string), coordinates (number[]) | Outlet, EventLocation                |
| Duration     | startHour, startMinute, endHour, endMinute | Business (schedule)             |
| DaySchedule  | duration (Duration)                   | Business (schedule)                  |
| Schedule     | weekDays (sun–sat, each DaySchedule)  | Business                             |

Event has its own `EventDuration` (Date-based) and `EventScheduleEntry` (date + durations[]) — kept local in `event.schema.ts` because the shape differs.

---

## Enums (`src/common/enums/index.ts`)

> **Data contract rule:** values must be byte-for-byte identical to the
> original PinnTag codebase. Any drift causes silent data corruption.

Key enums:

| Enum                  | Values (summary)                                   |
| --------------------- | -------------------------------------------------- |
| BusinessStatus        | CREATED(0), VERIFIED(1), SUBSCRIPTION(1.5), ...    |
| BusinessCreatorType   | ADMIN, BUSINESS_USER                               |
| OutletCategoryList    | PHYSICAL, MOBILE                                   |
| OutletTypes           | RESTAURANT, KIOSK, CAFE, BAR, ... (27+ types)     |
| EventTypes            | FORMAL, OFFER, PRIVATE, FLASHDEAL, SPOTLIGHT, DROPPED_PIN |
| EventStatus           | DRAFTED, PUBLISHED, CLOSED, BLOCKED                |
| DiscountType          | % Off, $ Off, BOGO, Free Item, ...                |
| FileType              | IMAGE, VIDEO, DOCUMENT, GIF, AUDIO, OTHER          |
| FileCategoryTypes     | PROFILE_PICTURE, THUMBNAIL, GALLERY_IMAGE, ...     |
| SubscriptionStatus    | ACTIVE, TRIAL, PAST_DUE, CANCELED, ...             |
| VerificationStatus    | NOT_VERIFIED, PENDING, VERIFIED, REJECTED          |

---

## Module Details

### Business

Schema: ~80 fields. Includes Stripe integration (account status, connect status), social media tokens (Facebook, Instagram, X), QR templates, verification workflow, and schedule/timing sub-schemas. Pre-save hook generates `uniqueId` (4-letter prefix + 3 digits + 3 letters). Text index on `name` + `tags`.

### Business User

Schema: name, email, phone, countryCode, profileStatus, creatorType, creator ref.

### Outlet

Schema: name, category (Physical/Mobile), business ref, address fields, location (2dsphere index), opening/closing times, vehicle info, social links, media fields.

### Event

Schema: type, status, discountType, creator, businessProfile ref, schedule (EventScheduleEntry[]), locations, targeting (age/gender), promotion codes, RSVP, Facebook integration, redemption settings. Virtual `files` field. Text index on `title` + `description`.

### Event Location

Schema: event ref, location (2dsphere index), address fields, business refs.

### Event Schedule

Schema: schedule configuration for events.

### Menu

Schema: name (required), description, business/outlet refs, menu items.

### Media

Schema: 3 sub-models (Image, Drive, File). FileType and FileCategoryTypes enums. 3 DTOs.

---

## Seeding Module (Pipeline)

The seeding module orchestrates the full lifecycle of bulk data import from upload to publishing into the production PinnTag database.

### Architecture

```
seeding/
├── seeding.module.ts
├── seeding.controller.ts              # 12 REST endpoints
├── schemas/
│   ├── seeding-session.schema.ts      # Batch container
│   ├── seeding-record.schema.ts       # Individual record
│   └── seeding-log.schema.ts          # Audit trail
├── dto/
│   ├── create-seeding-session.dto.ts
│   ├── bulk-upload-records.dto.ts
│   └── publish-session.dto.ts
├── engines/
│   ├── index.ts                       # Re-exports
│   ├── validation.engine.ts           # Pure validation logic
│   ├── transformation.engine.ts       # Pure transformation logic
│   └── enrichment.engine.ts           # Duplicate check against target DB
├── activation/
│   └── post-publish.service.ts        # Creates outlet + subscription post-publish
├── seeding-session.service.ts         # Session CRUD + stats
├── seeding-record.service.ts          # Record CRUD + bulk ops
├── seeding-log.service.ts             # Audit logging
└── seeding-pipeline.service.ts        # Orchestrator (delegates to engines)
```

### Pipeline Stages

```
RAW → VALIDATED → TRANSFORMED → ENRICHED → READY → PUBLISHED
```

Session statuses mirror these plus: `draft`, `validating`, `transforming`, `enriching`, `publishing`, `failed`, `cancelled`.

### SeedingSession

- Auto-generated `sessionId`: `DOP-YYYYMMDD-XXXX` (4 random uppercase letters)
- Targets one environment: `dev | staging | production`
- Embedded `stats` object tracks record counts per status
- `modules` array declares which data types are in the batch

### SeedingRecord

- One document per business/outlet/event/etc.
- `rawData` (Mixed) — original upload, never mutated
- `transformedData` (Mixed) — cleaned data for publishing
- `validationErrors` — array of `{ field, message, severity }`
- `enrichmentData` / `enrichmentSource` — for scraper/AI enrichment (placeholder)
- Compound index: `{ sessionId, module, status }`

### SeedingLog

- Audit trail for every pipeline action
- 14 action types: created, validated, validation_failed, transformed, etc.
- Actor is either an operator name or `'system'`

### Engines (`src/modules/seeding/engines/`)

Pure classes (no DI, no Mongoose) — instantiated directly in the pipeline service.

#### ValidationEngine (`validation.engine.ts`)

Validates raw crawler data with severity-aware rules:

| Module   | ERROR rules                                                         | WARNING rules                                        | INFO rules                        |
| -------- | ------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| business | name required (min 2), lat/lng range                                | email format, marketing_emails array format, website URL | email null, phone missing, categories missing |
| outlet   | name required (min 2), business ref required, lat/lng range         | category enum                                        |                                   |
| event    | title required (min 3), type enum, businessProfile required         |                                                      |                                   |
| menu     | name required                                                       |                                                      |                                   |
| others   | (no rules — returns empty)                                          |                                                      |                                   |

Key design: records with only WARNING/INFO errors still pass validation and move to `validated`. Only ERROR severity blocks progression.

#### TransformationEngine (`transformation.engine.ts`)

Three-phase transformation:

1. **Global cleaners** (all modules):
   - `removeNullFields` — strips null, undefined, empty strings so Mongoose uses schema defaults
   - `trimStrings` — trims all string values
   - `normalizeArrayFields` — converts `{ "a": "a" }` set-like objects into arrays

2. **Module-specific transforms**:
   - **business**: injects `creatorType: Admin`, `status: CREATED`, `isFromCrawler: true`, `verificationStatus: NOT_VERIFIED`, etc. Normalizes phone (digits only). Moves `categories` → `rawCategories` and `industry` → `rawIndustry` (strings kept for enrichment-phase ObjectId resolution). Builds geo `location` object. Lowercases tags.
   - **outlet**: injects `isFromCrawler`, `isActive: false`, `servingRadius: 60`. Builds geo location. Normalizes phone.
   - **event**: injects `status: DRAFTED`, `creatorType: BusinessUser`, zero counters, empty arrays for participants/responses.
   - **default**: injects `isFromCrawler: true`, `isDeleted: false`.

3. **rawData is never mutated** — engine deep-clones via `JSON.parse(JSON.stringify(...))`.

#### EnrichmentEngine (`enrichment.engine.ts`)

Connects to the **target** PinnTag DB and Google Places API. Instantiated per-call in `runEnrichment()` with `(targetConnection, googleApiKey, pinntagBusinessUserEmail)`.

**Business enrichment pipeline** (in order):

1. **Duplicate check** — queries target DB for existing documents matching `name`/`email`/`phone` via `$or`. Name match = ERROR (blocks), email/phone = WARNING.
2. **Google Places autocomplete** — sends address (or name as fallback) to Places API `v1/places:autocomplete` with Atlanta location bias. Gets `placeId`.
3. **Google Places details** — fetches full place details: address components, coordinates, rating, userRatingCount, regularOpeningHours. Parses address components with same fallback chain as live GoogleService (`street_number`+`route` → `premise` → `establishment` → `plus_code`). Parses opening hours into `weekDays` schedule format (handles 24/7 detection).
4. **Category resolution** — maps `rawCategories` string array to `BusinessCategory` ObjectIds from target DB (queries by `title`). Unresolved names logged as WARNING.
5. **Industry resolution** — maps `rawIndustry` string to `BusinessIndustry` ObjectId from target DB.
6. **Authorised user resolution** — finds `BusinessUser` by `PINNTAG_BUSINESS_USER_EMAIL` in target DB.

Other modules: pass-through (no enrichment).

### Post-Publish Activation (`activation/`)

After a business record is published, fires in the background (via `setImmediate`) to:

1. Create a **Physical Outlet** copying address/phone/location from the business
2. Find a free `SubscriptionProduct` and create an **active Subscription** (1 year)
3. Link outlet and subscription back to the business document
4. Assign business to the PinnTag operator `BusinessUser` (email from `PINNTAG_BUSINESS_USER_EMAIL` env var)
5. Create a **Drive** for the business (checks for existing, gets default space from Admin collection)
6. Create a **Gallery folder** inside the drive
7. Link `drive` and `galleryPath` back to the business document

**`post-publish.service.ts`** — NestJS injectable, orchestrates the full activation flow against the target DB. Returns `{ success, message, details: { outletId, subscriptionId, driveId, galleryFolderId } }`.

**`drive-activation.service.ts`** — plain class (not injectable), instantiated per-call. Replicates `SeederService.createDrive()` and `DriveService.createFolder()` from the original codebase. Idempotent (checks for existing drive/folder before creating).

### Publishing

- Target URI is **config-driven** — resolved from `EnvironmentUriKey[session.environment]` → `ConfigService`. No URIs in request bodies.
- Creates a **separate** `mongoose.createConnection(targetUri)` — never writes to the DOP database
- Inserts `transformedData` into the target collection per module
- Collection mapping: business→businesses, outlet→outlets, event→events, event-location→eventlocations, event-schedule→eventschedules, menu→menus, media→media
- Tracks success/failure per record, updates session stats and final status

### REST Endpoints

All under `/api/v1/seeding/`:

| Method | Path                             | Action                  |
| ------ | -------------------------------- | ----------------------- |
| POST   | /sessions                        | Create session          |
| GET    | /sessions                        | List sessions (filters) |
| GET    | /sessions/:id                    | Get session detail      |
| PATCH  | /sessions/:id/cancel             | Cancel session          |
| POST   | /sessions/:id/records            | Bulk upload records     |
| GET    | /sessions/:id/records            | List records (filters)  |
| GET    | /sessions/:id/records/:rid       | Get single record       |
| POST   | /sessions/:id/validate           | Run validation          |
| POST   | /sessions/:id/transform          | Run transformation      |
| POST   | /sessions/:id/enrich             | Run enrichment          |
| POST   | /sessions/:id/approve            | Approve for publishing  |
| POST   | /sessions/:id/publish            | Publish to target DB    |
| GET    | /sessions/:id/logs               | Get session audit logs  |
| GET    | /sessions/:id/stats              | Get status summary      |

---

## Key Design Decisions

1. **Seeding DB is separate from PinnTag DB.** The DOP API has its own Mongo database for sessions/records/logs. Publishing creates a separate connection to the target PinnTag database.

2. **rawData is immutable.** The original uploaded JSON is stored in `rawData` and never modified. All transformations go into `transformedData`.

3. **Enum values are data contracts.** All enum values in `src/common/enums/index.ts` must match the PinnTag production codebase exactly.

4. **Shared sub-schemas.** Common Mongoose sub-schemas (Hours, TimeBracket, LocationType, Duration, DaySchedule, Schedule) are defined once in `src/common/schemas/shared.schema.ts` and imported by modules that need them.

5. **Global validation.** `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true` strips unknown properties and rejects unexpected fields on all endpoints.

6. **No magic strings.** All statuses, actions, environment names, module names, log message templates, projections, and sort orders live in `src/common/constants/`. Schemas, DTOs, and services import from constants — no inline string literals for reusable values.

---

## Constants (`src/common/constants/`)

All reusable values are centralized here. Imported via `../../common/constants`.

### `seeding.constants.ts`

| Export                | Purpose                                             |
| --------------------- | --------------------------------------------------- |
| SeedingEnvironments   | `DEV`, `STAGING`, `PRODUCTION`                      |
| SeedingSessionStatus  | 12 session statuses (`DRAFT` through `CANCELLED`)   |
| SeedingRecordStatus   | 8 record statuses (`RAW` through `SKIPPED`)         |
| SeedingModules        | 7 module names (`BUSINESS` through `MEDIA`)         |
| SeedingLogActions     | 14 audit log action types                           |
| ValidationSeverity    | `ERROR`, `WARNING`, `INFO`                          |
| SeedingLogMessages    | Template functions for all log messages              |
| SeedingProjections    | Mongoose projections for session/record/log queries  |
| SeedingDefaults       | Default stats object, sort order, system actor, session ID config |
| EnvironmentUriKey     | Maps environment name → ConfigService key for target DB URI |
| SeedingErrorMessages  | Template functions for error messages (not found, duplicates, etc.) |
| PostPublishActions    | Action constants for post-publish activation logging |
| PostPublishMessages   | Template functions for activation log messages |

### `business.constants.ts`

| Export              | Purpose                                  |
| ------------------- | ---------------------------------------- |
| BusinessProjections | `list`, `detail`, `populate` projections |
| BusinessSortOrders  | `default`, `byName`, `byRating`          |

### `outlet.constants.ts`

| Export            | Purpose                        |
| ----------------- | ------------------------------ |
| OutletProjections | `list`, `detail` projections   |
| OutletSortOrders  | `default`                      |

### `event.constants.ts`

| Export           | Purpose                        |
| ---------------- | ------------------------------ |
| EventProjections | `list`, `detail` projections   |
| EventSortOrders  | `default`, `byViews`           |

### `media.constants.ts`

| Export           | Purpose                            |
| ---------------- | ---------------------------------- |
| MediaProjections | `fileList`, `imageList` projections |

### `validation.constants.ts`

| Export             | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| ValidationMessages | Template functions for field validation error messages |
| ValidationLimits   | Per-module field length/count constraints             |

### `google.constants.ts`

| Export                        | Purpose                                          |
| ----------------------------- | ------------------------------------------------ |
| GooglePlacesConfig            | API URLs, default coordinates, field masks       |
| GoogleAddressComponentTypes   | Address component type strings for parsing        |
| GoogleDayMap                  | Index-to-day-name mapping (0=sunday...6=saturday) |
| GoogleDefaultWeekDays         | Factory for zeroed-out weekly schedule            |
| Google247WeekDays             | Factory for 24/7 weekly schedule                  |
