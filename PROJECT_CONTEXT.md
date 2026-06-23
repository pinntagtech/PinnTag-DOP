# PinnTag DOP — Project Context

> Complete operational snapshot of the **PinnTag Data Operations Portal**
> (DOP). Written 2026-06-05. Pick up here without losing prior context.

Note: the user's session-history transcripts were unavailable, so this
doc is reconstructed directly from the source tree at
`/Users/rahulsharma/Desktop/Playground/pinntag-dop/`. Everything below
reflects the current state of the code.

---

## 1. Project overview

**PinnTag DOP** is an internal data-operations tool used by PinnTag
operators to **seed, enrich, scrape, publish, and migrate** business
records into the live PinnTag MongoDB databases (dev, pre-prod, staging,
production).

The DOP runs as **three independent apps** in a yarn/npm workspaces
monorepo:

```
pinntag-dop/
├── apps/
│   ├── api/        — NestJS 11 + Mongoose 9 backend
│   ├── portal/     — React 19 + Vite 8 + TanStack Query operator UI
│   └── bot/        — Python FastAPI + Playwright Google Maps scraper
├── packages/
│   └── types/      — Shared TS types (SeedingSession, SeedingLog, …)
├── deploy/         — EC2 / S3 / CloudFront deploy scripts
├── after_scr.sh
├── PinnTag-DOP-Bot.zip
└── package.json    — workspace root
```

Workspaces declared in root `package.json`:

```json
{
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "api":     "npm run start:dev --workspace=apps/api",
    "portal":  "npm run dev       --workspace=apps/portal",
    "build:api":    "npm run build --workspace=apps/api",
    "build:portal": "npm run build --workspace=apps/portal"
  }
}
```

---

## 2. Tech stack

| Layer    | Stack |
|----------|-------|
| Backend  | NestJS 11, Mongoose 9, TypeScript 5.7, JWT + Passport, class-validator, hbs templates, nodemailer (`@nestjs-modules/mailer`), `@aws-sdk/client-s3` |
| Frontend | React 19, Vite 8, TanStack Query 5, React Router 7, lucide-react icons, Tailwind 4 (via `@tailwindcss/vite`), date-fns 4 |
| Bot      | Python 3.11, FastAPI 0.115, Uvicorn, Playwright 1.58 (Chromium), httpx 0.27, pydantic |
| Infra    | AWS EC2 (`107.23.203.205`, Ubuntu, PM2, nginx, certbot/Let's Encrypt) + AWS S3 + CloudFront for portal + Backblaze B2 (S3-compatible) for media + MongoDB Atlas |
| Auth     | JWT access (15m) + refresh (7d) bcryptjs hashing, role-based + env-scoped guards |

---

## 3. The four PinnTag environments

`SeedingEnvironments` (apps/api/src/common/constants/seeding.constants.ts):

```ts
DEV         = 'dev'
PRE_PROD    = 'pre-prod'
STAGING     = 'staging'
PRODUCTION  = 'production'
```

Each environment points to a different MongoDB cluster URI via
`EnvironmentUriKey`:

```ts
dev        → database.pinntagDev
pre-prod   → database.pinntagPreProd
staging    → database.pinntagStaging
production → database.pinntagProd
```

**Active URIs (production env, EC2 `apps/api/.env.production`):**

| Env        | URI |
|------------|-----|
| DOP (internal) `MONGO_URI` | `mongodb+srv://robinpinntag:…@pinntagdev.gmwahpq.mongodb.net/pinntagDOP` |
| dev        | `mongodb+srv://robinpinntag:…@pinntagdev.gmwahpq.mongodb.net/pinntagProdLts` |
| pre-prod   | `mongodb+srv://robinPinnTagProd:…@pinntag-production.vhpri60.mongodb.net/pinntagPreProd` |
| staging    | `mongodb+srv://robinpinntag:…@pinntagdev.gmwahpq.mongodb.net/pinntagStaging` |
| production | `mongodb+srv://robinPinnTagProd:…@pinntag-production.vhpri60.mongodb.net/pinntagProd` |

`dev` historically pointed to the **pinntagProdLts** cluster — that's the
"dev/lts" target. Local dev `.env` swaps `pinntagDev` to that same Atlas
cluster.

---

## 4. Deployment

### EC2 (API)
- Host: `107.23.203.205` (region us-east-1, Ubuntu)
- SSH: `ssh -i ~/.ssh/pinntag.pem ubuntu@107.23.203.205`
  (deploy script uses `~/.ssh/id_rsa`)
- App dir: `/home/ubuntu/pinntag-dop`
- Process manager: **PM2** (`pinntag-dop-api`, single instance, NODE_ENV=production)
- Local API port: **3003** (PORT=3003 in `.env.production`)
- nginx terminates SSL → proxies to `localhost:3003`
- nginx config: `deploy/nginx-dop-api.conf` (also has reverse-proxy
  on `dop-api.pinntag.com`)
- SSL: Let's Encrypt via `certbot --nginx -d dop-api.pinntag.com`
- One-time bootstrap: `deploy/setup-ec2.sh` installs Node 22, PM2,
  certbot, creates `/home/ubuntu/pinntag-dop/apps/api`.

### S3 + CloudFront (Portal)
- Bucket: `pinntag-dop-portal` (us-east-1, public read, static
  website hosting on)
- CloudFront distribution ID: `E3CF1BZKZWSEJK`
- Domain: `https://dop.pinntag.com` (CNAME → CF)
- SPA fallback: custom-error 403 → `/index.html` 200
- One-time bootstrap: `deploy/setup-aws.sh` (creates bucket + ACM cert +
  CF distribution)

### Bot source distribution
- Same bucket `pinntag-dop-portal/bot-source/` holds installer payload
- Operator install URLs:
  - Mac/Linux: `curl -fsSL https://dop.pinntag.com/bot-source/install.sh | bash`
  - Windows:   `irm https://dop.pinntag.com/bot-source/install.ps1 | iex`

### Domains

| Domain                  | Purpose                          |
|-------------------------|----------------------------------|
| `dop.pinntag.com`       | DOP portal (CloudFront → S3)    |
| `dop-api.pinntag.com`   | DOP API (nginx → EC2 port 3003) |
| `media-staging.pinntag.com` | B2 CDN for media uploads    |

### Deploy commands

```bash
# Portal (S3 + CloudFront invalidate)
bash deploy/deploy-portal.sh

# API (build + rsync + PM2 restart on EC2)
bash deploy/deploy-api.sh

# Bot source (push installer + python files to S3)
bash deploy/upload-bot-source.sh
```

---

## 5. API — modules, services, controllers, endpoints

`AppModule` (apps/api/src/app.module.ts) imports:

```
DatabaseModule, AuthModule, BusinessModule, BusinessUserModule,
OutletModule, EventModule, EventLocationModule, EventScheduleModule,
MenuModule, MediaModule, SeedingModule
```

Global config: `app.config.ts` (env vars), `database.config.ts` (URIs).
Global pipes: `ValidationPipe` with whitelist + transform.
Global filter: `HttpExceptionFilter`.
Global prefix: `api/v1`.
CORS: enabled.
Body limit: 50mb (for JSON uploads).
Bootstrap hook: `authService.bootstrapRootAdmin()` runs on startup —
creates `ROOT_ADMIN_EMAIL` super_admin if missing.

### 5.1 AuthModule (`apps/api/src/modules/auth/`)

Files:
- `auth.module.ts`, `auth.service.ts`, `auth.controller.ts`
- `dop-mail.service.ts` — welcome email via `@nestjs-modules/mailer`
- `strategies/jwt.strategy.ts`
- `guards/jwt-auth.guard.ts`, `roles.guard.ts`, `env.guard.ts`
- `decorators/public.decorator.ts`, `roles.decorator.ts`, `current-user.decorator.ts`
- `interceptors/audit.interceptor.ts` (APP_INTERCEPTOR; writes to AuditLog capped collection)
- `schemas/dop-user.schema.ts`, `audit-log.schema.ts`, `refresh-token.schema.ts`
- `templates/dop-welcome.hbs`

Endpoints (`/api/v1/auth/...`):

| Method | Path                | Notes |
|--------|---------------------|-------|
| POST   | `/login`            | email/password → access + refresh tokens |
| POST   | `/refresh`          | refresh → new access + refresh |
| POST   | `/logout`           | revoke refresh token |
| GET    | `/me`               | current user profile (JWT) |
| GET    | `/users`            | super_admin only — list DOP users |
| POST   | `/users`            | super_admin only — create user + send welcome email |
| PATCH  | `/users/:id`        | super_admin only — update fields incl. password |
| DELETE | `/users/:id`        | super_admin only |
| GET    | `/audit-logs`       | super_admin or admin — paginated + filtered |

### 5.2 SeedingModule (`apps/api/src/modules/seeding/`)

The heart of DOP. Controllers, services, engines, jobs, migration, CVB.

Services:
- `SeedingSessionService` — CRUD on sessions, status transitions, stats
- `SeedingRecordService` — CRUD on records, bot progress, validation errors, finds
- `SeedingLogService` — append-only log table per session
- `SeedingPipelineService` — runs `validate → transform → enrich → approve → publish`, plus `reEnrich`, `resetSession`, `deleteSession`, `resetBotStages`
- `PostPublishService` (activation/) — creates Outlet, Subscription, Drive, Gallery folder after a Business publishes; resolves industry/category strings → ObjectIds; **multi-location detection** (same-name → reuse parent business, add outlet only)
- `DriveActivationService` (activation/) — creates `Drive` + `Gallery` folder docs in target DB
- `BotJobService` (bot/) — Mongo-backed bot job queue (`dopBotJobs`) with claim/poll/complete/reset-stuck
- `BotWebhookService` (bot/) — receives scraped data, uploads to B2, fills `files/folders/menus/reviews` in target DB, runs auto-cover logic, handles CVB logo/cover auto-apply
- `MigrationService` (migration/) — copies a published session into a new env; replicates Business + Outlet + Drive + Folders + Files + Menus + MenuItems + Reviews + logo/cover + industry/category resolution
- `CvbService` (cvb/) — query CVB-tagged staging businesses, import them into a CVB session, validate + auto-fix

Engines (engines/):
- `ValidationEngine` — schema-style checks per module
- `TransformationEngine` — moves string industry/categories into `rawIndustry`/`rawCategories`; field normalization
- `EnrichmentEngine` — Google Places enrichment + author resolution (uses target DB connection)
- `scraper-adapter.ts` — `adaptScraperData()` converts raw scraper JSON + email map into Business records

Controller (`seeding.controller.ts`) endpoints (`/api/v1/seeding/...`):

References:
- `POST /seed-references` — seed PinnTag system business user in target DB

Sessions:
- `POST /sessions` — create
- `POST /sessions/import-scraper` — multipart upload (scraper JSON + email map) → auto-creates a session with transformed records
- `GET  /sessions` — list (filter by env, status, createdBy)
- `GET  /sessions/:id`
- `PATCH /sessions/:id/cancel`

Records:
- `POST /sessions/:id/records` — bulk upload
- `GET  /sessions/:id/records`
- `GET  /sessions/:id/records/full`
- `GET  /sessions/:id/records/:rid/full`
- `GET  /sessions/:id/records/:rid`
- `PATCH /records/:id` — update raw / transformed (preserves industry/categories)

Pipeline:
- `POST /sessions/:id/validate`
- `POST /sessions/:id/transform`
- `POST /sessions/:id/enrich`
- `POST /sessions/:id/re-enrich` (body: `recordIds`)
- `POST /sessions/:id/approve`
- `POST /sessions/:id/publish` — operator+

Admin:
- `POST /sessions/:id/reset` (admin+, requires `DOP_ADMIN_PASSWORD`)
- `POST /sessions/:id/reset-bot` (`stages: gallery|menu|reviews`)
- `POST /sessions/:id/assign-cover-as-logo` — copies `cover` → `logo` for businesses whose logo is missing or still a googleusercontent URL
- `DELETE /sessions/:id` (admin+)

Logs & stats:
- `GET /sessions/:id/logs`
- `GET /sessions/:id/stats`

Bot endpoints (public, secured via `x-bot-secret` header):
- `POST /bot/webhook` — bot pushes scrape result (reviews/gallery/menu/imageSync)
- `POST /bot/progress` — granular per-stage progress updates
- `GET  /sessions/:id/bot-status`
- `POST /sessions/:id/trigger-bot` — creates BotJobs (`gallery_menu`, `reviews`, `image_sync`)
- `GET  /bot/poll` — long-polled by bot every 5s; returns next pending job
- `POST /bot/job/:id/complete` — bot reports success/failure
- `GET  /sessions/:id/bot-jobs` — stats `{pending, running, done, failed}`

Migration:
- `POST /sessions/:id/check-migration` — returns `{conflicts, clean}` lists
- `POST /sessions/:id/migrate` (admin+) — runs full migration

CVB:
- `GET  /cvb/businesses` — paginated filter on staging DB `isCvb: true`
- `GET  /cvb/filters` — available city/state/industry/category filters
- `POST /sessions/:id/import-cvb` — import selected businesses into a CVB session
- `POST /sessions/:id/cvb-validate`
- `POST /sessions/:id/cvb-autofix`
- `POST /records/:id/cvb-apply-fix`
- `POST /records/:id/cvb-reject-fix`

### 5.3 Other modules

Each follows `{module}.controller.ts`, `{module}.service.ts`,
`{module}.repository.ts`, `{module}.schema.ts`, `dto/` shape:

- **business** — Business CRUD
- **business-user** — BusinessUser CRUD
- **outlet** — Outlet CRUD
- **event** / **event-location** / **event-schedule** — Events stack
- **menu** — Menu CRUD
- **media** — Media CRUD

These exist primarily so the seeding/migration logic has working
models when not going through generic `strict: false` schemas.

---

## 6. Portal — pages, components, hooks

`apps/portal/src/App.tsx` routes (under `<Layout/>` inside `<ProtectedRoute>`):

| Route               | Page                  | Access |
|---------------------|-----------------------|--------|
| `/dashboard`        | DashboardPage         | any signed-in |
| `/sessions`         | SessionsPage          | any |
| `/sessions/:id`     | SessionDetailPage     | any |
| `/publishing`       | PublishingPage        | any |
| `/validation`       | ValidationQueuePage   | any |
| `/users`            | UsersPage             | super_admin only |
| `/audit-logs`       | AuditLogsPage         | super_admin or admin |
| `/login`            | LoginPage             | public |

### Pages (`apps/portal/src/pages/`)

- **DashboardPage.tsx** — high-level metrics + recent sessions
- **SessionsPage.tsx** — list/filter/create sessions, scraper import entry
- **SessionDetailPage.tsx** — full session UX: header + action buttons
  (`Validate`, `Transform`, `Enrich`, `Approve`, `Publish`, `Fetch
  reviews`, `Fetch gallery & menu`, `Sync images`, `Cover → Logo`,
  `Migrate`, `Validate all`, `Auto-fix safe`); pipeline strip; stats
  grid; tabs (`records | logs | cvb`); record detail side panel; admin
  menu (reset/delete/reset bot stages); modals for upload, migration,
  reviews-confirm, gallery-confirm, admin password.
  Current gating: Sync images, Cover → Logo, Fetch reviews, Fetch
  gallery & menu show whenever `session.totalRecords > 0`; only
  **Migrate** remains gated to `session.status === 'published' &&
  session.type !== 'migration'`. (Just changed — see Section 18.)
- **PublishingPage.tsx** — review what's ready to publish
- **ValidationQueuePage.tsx** — records with errors/warnings
- **LoginPage.tsx**
- **UsersPage.tsx** — super_admin only
- **AuditLogsPage.tsx**

### Components (`apps/portal/src/components/`)

`auth/`
- `ProtectedRoute.tsx` — wraps routes; redirects to `/login` if no token; enforces `requiredRole`

`layout/`
- `Layout.tsx` — sidebar + topbar shell
- `NavItem.tsx`

`sessions/`
- `CreateSessionModal.tsx`
- `UploadRecordsModal.tsx`
- `ScraperImportModal.tsx` (scraper JSON + email map)
- `CvbImportPanel.tsx`
- `MigrationModal.tsx` (env target picker + conflict resolution)
- `AdminPasswordModal.tsx` (gates reset/delete with `DOP_ADMIN_PASSWORD`)
- `RecordDetailPanel.tsx`

`ui/`
- `Badge.tsx`, `Button.tsx`, `Card.tsx`, `PipelineStrip.tsx`,
  `Skeleton.tsx`, `StatCard.tsx`, `BotProgressBar.tsx`
  (with `BotProgressCompact` sub-component)

### Hooks (`apps/portal/src/hooks/`)

- `use-sessions.ts` — `useSessions`, `useSession`, `useSessionStats`,
  `useSessionLogs`, `useCreateSession`, `usePipelineAction`,
  `useResetSession`, `useDeleteSession`, `useTriggerBotScrape`,
  `useResetBotStages`, `useCvbValidate`, `useCvbAutoFix`,
  `useAssignCoverAsLogo`. Heavy 3s `refetchInterval` on session detail
  and logs.
- `use-records.ts` — `useSessionRecords`, `useReEnrich`

### Contexts

- `AuthContext.tsx` — user, login, logout, token refresh
- `EnvironmentContext.tsx` — currently-selected env filter

### API client (`apps/portal/src/lib/api-client.ts`)

axios instance with `VITE_API_URL || 'https://dop-api.pinntag.com'`
+ `/api/v1`. Auto-injects bearer token from `dop_access_token`
localStorage. Response interceptor catches 401s and tries
`/auth/refresh` once before redirecting to `/login`.

---

## 7. Bot — architecture

`apps/bot/main.py` (FastAPI + Playwright).

### Polling architecture

On startup `lifespan()` spawns `polling_loop()`:
- Every **5s** hits `GET {DOP_API_URL}/api/v1/seeding/bot/poll`
  with `x-bot-secret` header
- API returns `{job: null}` if no work, else a `BotJob` doc
- Bot dispatches by `job.type`:
  - `gallery_menu` → `run_scrape(...)` with `skipReviews=true`
  - `reviews`      → `run_scrape(...)` with `skipGallery=true, skipMenu=true`
  - `image_sync`   → `run_image_sync(req)` (extracts cover + logo from Google Maps)
- On finish, bot POSTs `/api/v1/seeding/bot/job/:id/complete`
  with `{success, error?}`

This replaces direct push from API — the API just enqueues a Mongo
doc; whichever bot instance polls first runs it. Multiple operators
can run the bot in parallel.

### Scrape outputs

`scraper_bulk.py` exports `scrape_gallery`, `scrape_menu`,
`scrape_reviews`, `PlaceTask`, `WorkerState`. `main.py` calls them via
`async_playwright()` in a stealth-hardened Chromium (headless for
gallery+menu, headful for reviews because Google session cookies are
required).

Progress events stream to `/api/v1/seeding/bot/progress` via
`send_progress()` so the portal sees real-time per-folder counts.

Final results POST to `/api/v1/seeding/bot/webhook` with shape:
```json
{
  "placeId": "...",
  "businessId": "...",
  "environment": "...",
  "sessionId": "...",
  "reviews": [...],
  "gallery": [{folder_name, media: [{url, type, thumbnail_url?}]}],
  "menu":    [{name, photo_url, section, ...}],
  "imageSync": {"cover": "...", "logo": "..."}    // only for image_sync jobs
}
```

### Bot config (`apps/bot/.env`)

```
DOP_API_URL_DEV=http://localhost:3000
DOP_API_URL_PRE_PROD=https://dop-api.pinntag.com
DOP_API_URL_STAGING=https://dop-api.pinntag.com
DOP_API_URL_PRODUCTION=https://dop-api.pinntag.com
DOP_ENV=staging
DOP_API_WEBHOOK_SECRET=pinntag_bot_2026
GOOGLE_COOKIES_PATH=./google_cookies.json
MAX_REVIEWS=100
MAX_GALLERY_PER_FOLDER=50
HEADLESS=false
LOG_LEVEL=INFO
```

### Bot files
- `main.py` — FastAPI service + polling loop + scrape runners + image_sync
- `scraper_bulk.py` — Playwright scrapers (gallery / menu / reviews)
- `scraper.py` — older single-place CLI scraper (kept for reference)
- `auto_setup_cookies.py` — interactive Google login → writes `google_cookies.json`
- `requirements.txt` — fastapi, uvicorn, playwright, pymongo, python-dotenv, httpx, openpyxl
- `install.sh` / `install.ps1` — operator installers
- `OPERATOR_SETUP.md` — operator-facing Mac/Linux/Windows guide
- `README.md` — dev quick reference

---

## 8. Schemas

### 8.1 DOP-internal DB (`pinntagDOP`)

#### `seedingsessions`
`SessionId` (auto `DOP-YYYYMMDD-XXXX`), `name`, `description`,
`createdBy`, `environment` (dev/pre-prod/staging/production),
`status` (enum below), `totalRecords`, `stats {raw, validated,
transformed, enriched, ready, published, failed, skipped}`,
`modules: string[]`, `publishedAt`, `publishedBy`, `errorSummary`,
`metadata`, `type` (standard|migration|cvb),
`migratedFrom {sessionId, sessionName, environment, migratedAt}`.

Statuses: `draft, validating, validated, transforming, transformed,
enriching, enriched, ready, publishing, published, failed, cancelled,
migrating, migrated, cvb_importing, cvb_ready`.

#### `seedingrecords`
`sessionId` (ref), `module` (business|outlet|event|event-location|
event-schedule|menu|media), `status` (raw|validated|transformed|
enriched|ready|published|failed|skipped|bot_scraping|bot_done|
bot_failed), `rawData`, `transformedData`,
`validationErrors [{field, message, severity}]`, `enrichmentData`,
`enrichmentSource`, `publishedId`, `publishedAt`, `retryCount`,
`errorMessage`, `clientRefId`, `metadata`,
`botScrape {status, startedAt, completedAt, currentStage,
currentDetail, progress {gallery|menu|reviews}, reviewCount,
galleryFolders, galleryImages, menuItems, error}`,
`cvbBusinessId`,
`cvbFixes [{field, issue, currentValue, suggestedValue, riskLevel
(safe|manual), status (pending|approved|rejected|applied),
appliedAt, appliedBy}]`.

Indexes: `module`, `status`, `(sessionId, module, status)`.

#### `seedinglogs`
`sessionId`, `recordId?`, `action` (enum, see
`SeedingLogActions`), `actor`, `fromStatus`, `toStatus`, `message`,
`metadata`. Timestamps.

#### `dopBotJobs`
`placeId`, `businessId`, `businessName`, `environment`, `sessionId`,
`type` (gallery_menu|reviews|image_sync),
`status` (pending|running|done|failed), `maxReviews` (default 100),
`claimedAt`, `completedAt`, `error`, `attempts` (max 3).
Indexes: `(status, createdAt)`, `sessionId`.

#### `dopusers`
`email` (lowercase, unique), `passwordHash` (bcryptjs), `name`,
`role` (super_admin|admin|operator), `environments: string[]`,
`isActive`, `isRootAdmin`, `createdBy`, `lastLoginAt`.

#### `dopRefreshTokens`
`userId`, `tokenHash`, `expiresAt`, `ip`, `userAgent`, `revokedAt`.

#### `dopAuditLogs`
Capped (100 MB / 100k docs). `userId`, `userEmail`, `userName`,
`action`, `resource`, `resourceId`, `details`, `environment`, `ip`,
`userAgent`, `outcome` (success|failure|warning). Indexed on
`userId`, `action`, `resourceId`. Written automatically by
`AuditInterceptor`.

### 8.2 PinnTag target DBs (per env)

Touched by post-publish, bot-webhook, migration, reset-session, and
reset-bot-stages flows. Generic mongoose `strict: false` schemas are
used to read/write these without re-declaring the production schemas:

| Collection                | Used in |
|---------------------------|---------|
| `businesses`              | publish, post-publish, image-sync, bot-webhook (cover/logo, menus push), migration, reset |
| `outlets`                 | post-publish (create), reset (delete), migration (patch) |
| `subscriptions`           | post-publish (create), reset (delete) |
| `subscriptionproducts`    | post-publish lookup (free product) |
| `businessusers`           | post-publish (assign business to PinnTag user), seed-references, migration |
| `businessindustries`      | post-publish (create/lookup industry by name) |
| `businesscategories`      | post-publish (create/lookup category by name) |
| `drives`                  | DriveActivationService, bot-webhook, reset (delete) |
| `folders`                 | DriveActivationService, bot-webhook (subfolder per gallery folder), reset, migration |
| `files`                   | bot-webhook (B2 image refs), migration, reset |
| `menus`                   | bot-webhook (per gallery menu folder + per menu section), migration, reset |
| `menuitems`               | migration |
| `reviews`                 | bot-webhook (Google reviews upsert by externalReviewId), migration, reset |
| `events`, `eventlocations`, `eventschedules` | reset (cascade-delete by business) |
| `follows`, `feeds`        | reset (cascade-delete) |
| `filecategories`          | bot-webhook (lookup `gallery image` and `logo` categories) |

---

## 9. Auth system

- **JWT** access tokens (`JWT_ACCESS_SECRET`, 15m) + refresh tokens
  (`JWT_REFRESH_SECRET`, 7d).
- Refresh tokens stored hashed (`tokenHash`) in `dopRefreshTokens`,
  with `ip`/`userAgent`/`revokedAt`.
- Passwords hashed with **bcryptjs**.
- **Roles** (`DopUserRole`): `super_admin`, `admin`, `operator`.
- **Env scoping**: each `DopUser.environments` lists which envs they
  can act on; `EnvGuard` blocks ops on other envs.
- **Root admin**: auto-bootstrapped at startup from env vars
  (`ROOT_ADMIN_EMAIL`, `ROOT_ADMIN_PASSWORD`, `ROOT_ADMIN_NAME`).
  `isRootAdmin: true`.
- **Roles by route** (selected):
  - publish: `admin | super_admin | operator`
  - reset / delete: `admin | super_admin`
  - migrate: `admin | super_admin`
  - users / audit-logs: `super_admin` (audit logs allow admin too)
- **Audit logging**: `AuditInterceptor` is registered as
  `APP_INTERCEPTOR` — writes to capped `dopAuditLogs` for every
  controller hit by an authenticated user.
- **Welcome email**: `DopMailService` sends `dop-welcome.hbs` via
  AWS SES SMTP when admin creates a user with `sendCredentials: true`.

---

## 10. The complete seeding pipeline

Statuses progress through:

```
draft
  → (POST /validate)   validating → validated   (or failed)
  → (POST /transform)  transforming → transformed
  → (POST /enrich)     enriching → enriched   (uses target DB + Google + PinnTag API)
  → (POST /approve)    enriched → ready
  → (POST /publish)    publishing → published (or failed)
```

Each step:

1. **Validate** (`ValidationEngine.validate`) — required fields,
   formats per module. Errors set on
   `record.validationErrors`. Error severity → record `failed`;
   warnings only → `validated`.
2. **Transform** (`TransformationEngine.transform`) — normalizes
   keys, splits address strings, moves string industry/categories to
   `rawIndustry`/`rawCategories` so enrichment can resolve them.
3. **Enrich** (`EnrichmentEngine.enrich`) — opens target-DB
   connection, hits Google Places (`GOOGLE_MAPS_API_KEY`), looks up
   `authorisedUser` (`PINNTAG_BUSINESS_USER_EMAIL`), resolves
   industry/category ObjectIds, fills `placeId, rating, regularTiming,
   userRatingCount, latitude, longitude, …`. Records a detailed
   `Google enrichment` log per business record.
4. **Approve** — bulk flip records `enriched → ready`, session `enriched → ready`.
5. **Publish** — for every `ready` record:
   - Pre-publish duplicate check: blocks if `name | email | phone`
     matches existing business in target.
   - Inserts the `transformedData` doc into the env's collection (using
     `MODULE_COLLECTION_MAP`).
   - Marks record `published` with `publishedId`, logs
     `published` action.
   - Then, for `business` records, runs `PostPublishService` in
     **batches of 5 concurrent**, sharing one target-DB connection:
     - Multi-location detection (same-name business → use existing
       parent's `_id` for outlet/subscription; new business doc is
       kept but marked `isLocationOf: parentId, isActive: false`).
     - Resolve string `industry`/`categories` → ObjectIds, creating
       new docs in `businessindustries`/`businesscategories` as needed.
     - Create `Outlet` (one per location) and push to parent
       business's `outlets` array, `$inc activatedOutletsLength`.
     - Create free `Subscription` (skipped for multi-location
       satellites — parent already has one).
     - Mark satellite businesses `isLocationOf: parentId`.
     - Assign business to PinnTag system `BusinessUser` (`admin@pinntag.com`).
     - `DriveActivationService.createDriveForBusiness` (creates Drive
       doc + Gallery folder), links `drive` + `galleryPath` back onto
       business.

After publish, the session status flips to `published` (or `failed`
with `errorSummary`), `publishedAt`/`publishedBy` set.

### Re-enrich

`POST /sessions/:id/re-enrich` resets given record IDs (or all
`enriched`) back to `transformed`, then re-runs enrichment.

### Reset session (admin)

`POST /sessions/:id/reset` with `adminPassword`:
- For every `published` record, cascade-delete the target-DB doc and
  its related media:
  - `businesses` + dependent `outlets`, `events`, `eventlocations`,
    `eventschedules`, `follows`, `feeds`, `drives`, `folders`,
    `subscriptions`, `reviews`, `menus`, `files` (filtered to gallery
    subfolders, not the top-level `Gallery`/`Drive` folders).
- Resets all DOP records back to `raw`, session → `draft`.

### Delete session

Same as reset, plus deletes DOP `seedinglogs`, `seedingrecords`, and
the `seedingsession` doc.

### Reset bot stages (`gallery | menu | reviews`)

`POST /sessions/:id/reset-bot` — for each published business, deletes
the matching collections (reviews/menus + their menu image files /
gallery subfolders + their files) so operators can re-fetch.

---

## 11. Scraper import

`POST /sessions/:id/import-scraper` — handled in
`apps/api/src/modules/seeding/seeding.controller.ts`
(`importScraperData()`).

Multipart upload of up to 2 files:
- **scraper data** — JSON array of Google-Maps-like business records
  (auto-detected by name `scraper`/`data` or first file)
- **email map** — JSON `{websiteUrl: email}` map (optional)

`adaptScraperData()` (engines/scraper-adapter.ts) merges them with
optional `defaultIndustry` and `defaultCategories[]`, returning
`{records, stats {processed, emailMatched, noWebsite, categoryFallback}}`.

A new session is auto-created with status `transformed` (records skip
validation/transform engines because the adapter already produced
the canonical transformed shape), `module: business`. Records are
stored with `rawData === transformedData`.

Logged as `SeedingLogActions.SCRAPER_IMPORT`.

Portal entrypoint: `ScraperImportModal.tsx` from `SessionsPage`.

---

## 12. Bot job queue

Replaces the older direct-push model. Flow:

1. Operator clicks **Fetch reviews** / **Fetch gallery & menu** /
   **Sync images** in `SessionDetailPage`.
2. Portal calls `POST /sessions/:id/trigger-bot` with the eligible
   records and `type`.
3. `BotJobService.createJobs()` inserts one `dopBotJobs` doc per
   record (`status: pending`, `attempts: 0`).
4. Bot's `polling_loop()` calls `GET /bot/poll` every 5s with a
   shared `x-bot-secret`. The API:
   - Calls `BotJobService.resetStuckJobs()` (any job stuck `running`
     for >10 min, attempts<3, returns to `pending`).
   - Calls `claimNextJob(type?)`: `findOneAndUpdate` with sort
     `createdAt: 1` → atomic claim, status → `running`,
     `claimedAt: now`, `attempts++`.
5. Bot runs `run_scrape` or `run_image_sync` based on `job.type`.
6. Bot POSTs final webhook (`/seeding/bot/webhook`) with results.
7. Bot reports `/seeding/bot/job/:id/complete` `{success, error?}` →
   `BotJobService.completeJob` sets `done`/`failed`.

Eligible records (for portal client-side filtering in
`SessionDetailPage`):
```ts
botEligibleRecords = records.filter(r =>
  r.transformedData?.placeId &&
  ((r.status === 'published' && r.publishedId) ||
   (r.cvbBusinessId && session.type === 'cvb')))
```

`maxReviews` is capped at `Math.min(userRatingCount, 500)` (defaults
to 100).

---

## 13. Multi-location detection

In `PostPublishService.activateBusiness`:

```ts
existingParentBusiness = BusinessModel.findOne({
  name: /^<currentName>$/i,            // case-insensitive same name
  _id: { $ne: currentBusinessId },
  isDeleted: { $ne: true },
}).lean()

isMultiLocation = !!existingParentBusiness
outletBusinessId = isMultiLocation ? existingParent._id : currentBusiness._id
```

When detected:
- The new business doc is still inserted but marked
  `isLocationOf: parentBusinessId, isActive: false` (kept for tracking,
  no listing in PinnTag).
- The new `Outlet` is created against the **parent** business id.
- `activatedOutletsLength` is incremented on the parent.
- `Subscription` creation is **skipped** (parent already has one).
- Drive + Gallery folder are created on the parent (not the satellite).

---

## 14. Migration (full media copy)

`POST /sessions/:id/migrate` (admin+) — `MigrationService.migrate`:

1. Create a new "migration session" in target env with
   `type: 'migration'`, `status: 'migrating'`,
   `migratedFrom: {sessionId, sessionName, environment, migratedAt}`.
2. For each `published` source record (optionally filtered by
   `recordIds`):
   - If `conflictResolution[recordId] === 'skip'`, copy the DOP record
     as `skipped` and continue.
   - Otherwise insert a fresh `Business` doc in target env, deleting
     any existing doc with that `placeId` if `overwrite`. The doc is
     pulled from the *source* env's `businesses` collection (not just
     `transformedData`), so logo, cover, and any post-bot mutations
     come over.
   - Resolve source-env `businessIndustry`/`businessCategories`
     ObjectIds → names → re-lookup/create in target env (handled by
     post-publish later).
   - Strip `_id, __v, outlets, activeSubscription, drive, galleryPath,
     selectedBusiness, activatedOutletsLength`. Set
     `authorisedUser: <target env admin user>`, `isFromCrawler: true`,
     `dataFetchedFromGoogle: true`, `status: 4.1`, `isActive: true`,
     `isClaimed: false`, `creatorType: 'Admin'`, counters reset.
   - Update the DOP record with new `publishedId`.
   - Run `PostPublishService.activateBusiness()` (shared connection)
     to create Outlet, Subscription, Drive, Gallery.
   - **`migrateBusinessMedia()` copies media collections one-for-one**:
     - `drives → folders → files` (rewriting parent/drive/parentDirectory
       refs; two-pass to fix subfolder parentDirectory)
     - `menus → menuitems` (rewriting `business` and `menu` refs)
     - `reviews` (rewriting `business`)
     - logo/cover/coverUploaded/logoUploaded patched directly onto
       target business doc
   - Patch the auto-created Outlet's address/phone/email/website with
     the source outlet's values.
3. Logs `migration_complete` with totals `{migrated, skipped, failed,
   galleryCopied, menuCopied, reviewsCopied}`.

Conflict check: `POST /sessions/:id/check-migration` returns
`{conflicts: [{recordId, businessName, placeId, existingBusinessId}],
clean: [{recordId, businessName, placeId}]}` by matching `placeId` in
target env.

---

## 15. Image sync + Cover → Logo

### Image sync (`type: image_sync` BotJob)
- Bot opens the Google Maps place page (`run_image_sync` in main.py).
- Extracts `cover_url` via hero `img.RZ66Rb.FgCUCc` selectors and
  `logo_url` via `div.aoRNLd img` etc.
- Falls back to the business's own website (og:image / apple-touch-icon
  / favicon) when no logo is found.
- POSTs back `imageSync: {cover, logo}` to webhook.
- `BotWebhookService` downloads each URL → uploads to B2 → updates
  the target business with `cover`/`logo` URLs (B2-hosted) and the
  `*Uploaded: true` flags.

### Cover → Logo
- `POST /sessions/:id/assign-cover-as-logo` (in
  `seeding.controller.ts`).
- For all `publishedId` businesses where `cover` is uploaded and
  `logo` is missing, null, empty, not `coverUploaded`, or still a
  `lh3.googleusercontent` URL — sets `logo = cover, logoUploaded =
  true`.

### Auto-cover from gallery
- After every bot gallery scrape, `BotWebhookService` checks if the
  business has no usable cover (missing or googleusercontent-hosted)
  and if so, sets `cover` (and `logo` if also missing) from the first
  uploaded gallery image.

### CVB auto-apply
- For CVB records with pending `logo`/`cover` fixes whose
  `suggestedValue === '__fetch_from_bot__'`, the bot-webhook
  downloads the best gallery image (prioritizing folders: `by owner`,
  `food & drink`, `vibe`, `menu`, `barbecue`, `wine`), uploads to B2,
  patches the staging business doc, and marks the cvb fixes as
  `applied`.

---

## 16. Environment variables

### apps/api/.env (local dev) — sensitive values present in repo

```env
NODE_ENV=development
PORT=3000
API_PREFIX=api/v1
MONGO_URI=mongodb://localhost:27017/pinntag-dop
PINNTAG_DEV_MONGO_URI=mongodb+srv://robinpinntag:…@pinntagdev…/pinntagProdLts
PINNTAG_PRE_PROD_MONGO_URI=mongodb+srv://robinPinnTagProd:…@pinntag-production…/pinntagPreProd
PINNTAG_STAGING_MONGO_URI=mongodb+srv://robinpinntag:…@pinntagdev…/pinntagStaging
PINNTAG_PROD_MONGO_URI=mongodb://localhost:27017/pinntag-prod
GOOGLE_MAPS_API_KEY=AIzaSy…
PINNTAG_BUSINESS_USER_EMAIL=admin@pinntag.com
SEEDING_BATCH_SIZE=100
PINNTAG_API_URL=https://staging.pinntag.com
PINNTAG_API_TOKEN=eyJhbGciOi…
DOP_ADMIN_PASSWORD=pinntag_dop_2026
PINNTAG_INSIDER_API_KEY=AIzaSy…
PYTHON_BOT_URL=http://localhost:8000
BOT_WEBHOOK_SECRET=pinntag_bot_2026
B2_BUCKET_NAME=pinntag-media-staging
B2_REGION=us-east-005
B2_ENDPOINT=https://s3.us-east-005.backblazeb2.com
B2_ACCESS_KEY_ID=00564ed588572560000000002
B2_SECRET_ACCESS_KEY=K005S40L9yMo8XF9/KH7iceELw70ui8
CDN_DOMAIN=media-staging.pinntag.com
APP_ENV=dev
JWT_ACCESS_SECRET=pinntag_dop_access_secret_2026
JWT_REFRESH_SECRET=pinntag_dop_refresh_secret_2026
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
ROOT_ADMIN_EMAIL=admin@pinntag.com
ROOT_ADMIN_PASSWORD=PinnTag@DOP2026!
ROOT_ADMIN_NAME=Super Admin
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=AKIA2CUNLHD3ULIZ3P6O
SMTP_PASS=BH0z8M42BT1516FMB13rymSgOrkjjKUYs+k/VRr8FdQH
MAIL_FROM="PinnTag DOP" <noreply@pinntag.com>
DOP_APP_URL=http://localhost:5173
```

### apps/api/.env.production — deployed to EC2

```env
NODE_ENV=production
PORT=3003
MONGO_URI=mongodb+srv://robinpinntag:…@pinntagdev…/pinntagDOP
PINNTAG_DEV_MONGO_URI=…/pinntagProdLts
PINNTAG_PRE_PROD_MONGO_URI=…/pinntagPreProd
PINNTAG_STAGING_MONGO_URI=…/pinntagStaging
PINNTAG_PROD_MONGO_URI=…/pinntagProd
PINNTAG_API_URL=https://staging.pinntag.com
PINNTAG_API_TOKEN=eyJhbGciOi…
PINNTAG_INSIDER_API_KEY=AIzaSy…
PINNTAG_BUSINESS_USER_EMAIL=admin@pinntag.com
PYTHON_BOT_URL=http://localhost:8000
BOT_WEBHOOK_SECRET=pinntag_bot_2026
JWT_ACCESS_SECRET=01818c06b799cda070f81aeb87d70a7804dfa75fc96417ec04caec8eb669adee
JWT_REFRESH_SECRET=d89e0784bc772f0bbb6d1266a45f618a2bb1511dd47141b206bab6e74a9d7915
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
ROOT_ADMIN_EMAIL=admin@pinntag.com
ROOT_ADMIN_PASSWORD=PinnTag123!
ROOT_ADMIN_NAME='Rahul Sharma'
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=AKIA2CUNLHD3ULIZ3P6O
SMTP_PASS=BH0z8M42BT1516FMB13rymSgOrkjjKUYs+k/VRr8FdQH
MAIL_FROM="PinnTag DOP" <noreply@pinntag.com>
DOP_APP_URL=https://dop.pinntag.com
B2_BUCKET_NAME=pinntag-media-staging
B2_REGION=us-east-005
B2_ENDPOINT=https://s3.us-east-005.backblazeb2.com
B2_ACCESS_KEY_ID=00564ed588572560000000002
B2_SECRET_ACCESS_KEY=K005S40L9yMo8XF9/KH7iceELw70ui8
CDN_DOMAIN=media-staging.pinntag.com
APP_ENV=dev
GOOGLE_MAPS_API_KEY=AIzaSy…
DOP_ADMIN_PASSWORD=PinnTag123!
```

### apps/portal/.env.production

```env
VITE_API_URL=https://dop-api.pinntag.com
```

### apps/bot/.env

See Section 7. Operator-facing version is uploaded to S3 by
`deploy/upload-bot-source.sh` (without secrets except the webhook
shared key).

---

## 17. Deploy scripts cheat-sheet

| Script | Purpose |
|--------|---------|
| `deploy/setup-aws.sh` | One-shot: create S3 bucket `pinntag-dop-portal`, request ACM cert, create CloudFront distribution, print DNS records to add (`dop.pinntag.com` CNAME → CF, `dop-api.pinntag.com` A → EC2 IP) |
| `deploy/setup-ec2.sh` | Run **on the EC2 instance** once: install Node 22, PM2 + systemd, certbot, create app dir |
| `deploy/deploy-api.sh` | `npm run build` locally → rsync `apps/api/dist/` + `package.json` + `package-lock.json` + `nest-cli.json` to EC2 → `npm install --production` → `pm2 restart pinntag-dop-api` (or first-time start with `-i 1`) → health check `http://EC2:3001/api/v1/health` (note: code/nginx use 3003, script comment shows 3001 — see Known Issues) |
| `deploy/deploy-portal.sh` | `npm run build` (uses `apps/portal/.env.production`) → `aws s3 sync dist/ s3://pinntag-dop-portal/` with long cache, then upload `index.html` with `no-cache` → `aws cloudfront create-invalidation --distribution-id E3CF1BZKZWSEJK --paths /*` |
| `deploy/upload-bot-source.sh` | Push `apps/bot/{main.py, scraper_bulk.py, auto_setup_cookies.py, requirements.txt}` + sanitized `.env` + `install.sh` + `install.ps1` to `s3://pinntag-dop-portal/bot-source/` |
| `deploy/nginx-dop-api.conf` | nginx site for `dop-api.pinntag.com` (port 443 → `localhost:3003`) |

Standard local dev cycle:
```bash
npm run api        # NestJS on :3000
npm run portal     # Vite on :5173
cd apps/bot && source venv/bin/activate && uvicorn main:app --host 0.0.0.0 --port 8000
```

Production deploy cycle:
```bash
# After committing
bash deploy/deploy-api.sh
bash deploy/deploy-portal.sh
# Bot installer updates
bash deploy/upload-bot-source.sh
```

---

## 18. Recent change in this session

`apps/portal/src/pages/SessionDetailPage.tsx` — the four post-publish
action buttons (Fetch reviews, Fetch gallery & menu, Sync images,
Cover → Logo) used to be gated by `session.status === 'published'`.
They are now gated by `session.totalRecords > 0` so operators can
trigger them at any pipeline stage as long as records exist. **Migrate**
remains the only button restricted to
`session.status === 'published' && session.type !== 'migration'`.

Verified with `npx tsc --noEmit` — zero errors.

---

## 19. Pending items & known issues

- **Port mismatch in `deploy/deploy-api.sh`** — the script does
  `pm2 start dist/main.js` with no env override, so the API reads
  `PORT=3003` from `.env.production`. But the health-check at the end
  hits `http://$EC2_HOST:3001/api/v1/health`, which won't respond.
  The nginx config also targets `localhost:3003`. The health-check
  port should be updated to 3003 (or the API moved off 3003).
- **Local `.env` ships real Atlas credentials** for the shared
  PinnTag clusters. Should be moved to a secret store before this
  repo goes anywhere external.
- **PINNTAG_BUSINESS_USER_EMAIL** is read via two different keys in
  the codebase: `app.pinntagBusinessUserEmail` (most places) and
  `PINNTAG_BUSINESS_USER_EMAIL` (env-var-style, in
  `PostPublishService.activateBusiness`). The second only works
  because raw env vars pass through; consider unifying.
- **Bot polls a single shared API URL** — if operators on multiple
  envs all run bots, jobs are racy across all envs (claim is global).
  `type` filtering exists but env filtering doesn't; operators need
  to coordinate when running in parallel.
- **Reset-bot-stages** treats gallery subfolders by `folderName not in
  ['Gallery', 'Drive']` — fragile if seed data uses those names.
- **Backblaze B2 always writes to `pinntag-media-staging`** —
  `APP_ENV=dev` is hard-coded in `.env.production`. There is no
  separate prod B2 bucket today.
- **No tests** beyond NestJS's default `app.controller.spec.ts`. Jest
  is configured; coverage is empty.

---

## 20. Operator setup (install.sh / install.ps1)

Operators don't see the source tree — they get a one-liner that:

### Mac / Linux (`apps/bot/install.sh`)
1. Checks Python 3.11 (auto-installs via Homebrew on Mac or apt on
   Ubuntu).
2. On Linux installs Playwright runtime deps (libnss3, libdrm2, etc.).
3. Downloads `main.py`, `scraper_bulk.py`, `auto_setup_cookies.py`,
   `requirements.txt`, `.env` from
   `https://pinntag-dop-portal.s3.us-east-1.amazonaws.com/bot-source/`
   into `~/pinntag-dop-bot/`.
4. Creates a venv, `pip install -r requirements.txt`.
5. Installs Playwright Chromium.
6. Runs `auto_setup_cookies.py` (opens a Google login window;
   writes `google_cookies.json`).
7. Writes `~/pinntag-dop-bot/start.sh` that activates the venv,
   opens `https://dop.pinntag.com`, and runs
   `uvicorn main:app --host 0.0.0.0 --port 8000`.
8. Creates Desktop shortcut:
   - Mac: `~/Desktop/PinnTag DOP Bot.command`
   - Linux: `~/Desktop/PinnTag-DOP-Bot.desktop`
9. Starts the bot immediately.

### Windows (`apps/bot/install.ps1`)
Same flow via PowerShell — installs Python, downloads files,
creates venv, installs Chromium, runs cookie capture, builds a
Desktop shortcut, starts the bot.

### Refreshing Google cookies
Google sessions die after ~25 days. The fix per `OPERATOR_SETUP.md`:

> Delete `google_cookies.json` from `~/pinntag-dop-bot/`, restart the
> bot, sign in again when the window opens.

The webhook shared secret is the same across environments
(`pinntag_bot_2026`). The bot's active environment is set by
`DOP_ENV` in `~/pinntag-dop-bot/.env`. All envs in production point
at the single `https://dop-api.pinntag.com` API host — the API uses
the per-job `environment` field to know which target Mongo to touch.

---

*End of context. Use this doc as the starting point for any new
Claude session — combine with `git status` / `git log` to see what's
changed since.*
