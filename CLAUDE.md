# PinnTag DOP — Operating Context

You are working in the PinnTag Data Operations Platform. Read this fully before
acting. It replaces a human relaying context to you.

## Prime directive
World Cup 2026 go-live. Every seeded business promoted to production must pass
the quality gate AND render correctly in the consumer app. Speed matters, but
**DOP cannot make mistakes** — a bad bulk write is worse than a slow one.

## Autonomy
- Query staging MongoDB directly. Read URIs from `apps/api/.env.production`
  (`PINNTAG_STAGING_MONGO_URI`, `PINNTAG_PROD_MONGO_URI`,
  `PINNTAG_PRE_PROD_MONGO_URI`). Do not ask the user to run queries and paste
  results back.
- Write throwaway `.mjs` scripts in `/tmp` using the repo's `mongodb` driver
  (`ln -sf apps/api/node_modules .`) for diagnostics.
- Deploy yourself when a change is ready and verified.
- Ask the user only for: destructive decisions, policy calls, production
  writes, or when a number looks wrong and you cannot explain it.

## Non-negotiables
1. **Commit and push before ending any session.** Work has been permanently
   lost three times by leaving it uncommitted. Commit at checkpoints too.
2. **Dry-run → hand-picked sample (10-15) → batched full apply.** Every bulk
   write. No exceptions, including under urgency.
3. **Always pair `db.getName()` with any count query.** A staging count was
   once mistaken for a production duplication bug.
4. **Never touch organic businesses.** Every read and write is scoped by
   `buildSeededFilter()` from
   `apps/api/src/modules/seeding/common/seeded-cohort.ts`.
5. **Staging only.** Pre-prod and production writes happen exclusively through
   the `/gated-migration` page, run by the user.

## The cohort
Seeded = crawler OR CVB OR manual-seeder, materialized as
`Business.seedProvenance.isSeeded` (indexed). The legacy definition
(`isCvb OR isFromCrawler`) is INCOMPLETE — it missed 690 businesses created by
the internal seeding team (`@yopmail.com` accounts, `creatorType:'BusinessUser'`).
Never reintroduce the hardcoded `$or: [{isCvb:true},{isFromCrawler:true}]`.

Current staging: 24,602 seeded (crawler 16,127 / cvb 9,020 / manual 690).

## The 11-criteria gate
Source of truth: `apps/api/src/modules/seeding/console/gate-predicates.ts`.
Persisted per-doc as `Business.gateStatus`, recomputed via
`POST /seeding/console/gate/recompute`. Never compute live.

c1 active_outlet · c2 real_cover (`media-staging.pinntag.com` only) ·
c3 real_hours · c4 taxonomy_present · c5 valid_address · c6 singleton_placeId ·
c7 domestic_coords · c8 taxonomy_resolvable (deferred to migration resolver) ·
c9 verified_placeId (`confidence.match !== false`) · c10 verified_email ·
c11 verified_name (not built, always false)

## Hard-won facts (do not relearn these)
- **Visibility gate** = `isActive:true` AND ≥1 outlet with `isActive:true`
  linked via `outlet.business` back-ref. NOT the `status` field. A business can
  pass the whole gate and still be invisible if it has no outlet.
- **Outlets are distinct physical locations.** NEVER copy a parent business
  address onto an outlet. `DataRepairService.fixMissingOutlet` currently does
  this via `buildOutletBaseFromBusiness` — it is unsafe for that reason.
- **`addressLine1`** is the consumer display field, not `address1`.
- **DB Sync repairs; Migration promotes.** `sync/db-sync.service.ts` only
  patches already-present docs. `migration/migration.service.ts` creates them.
- **Taxonomy resolves by NAME** into the target DB. Never carry source
  ObjectIds across environments.
- **nginx 504 on long applies is cosmetic.** The server keeps working. Verify
  with `pm2 logs pinntag-dop-api --lines N --nostream` and a direct DB count,
  never the HTTP response.
- **Gated-migration apply is not cursor-based** — it re-scans from the start
  each call. `migrated:0` means the `limit` didn't reach past covered ground,
  not that it's broken. Console actions (`run.service.ts`) ARE cursor-based.
- **Array-typed fields**: some docs store `addressLine1`/`city`/`email`/
  `placeId` as arrays. `gate-predicates.ts` is safe (`typeof x === 'string'`),
  but any new aggregation using `$strLenCP` must guard with `$isArray` +
  `$arrayElemAt` or it throws.
- **Placeholder covers**: `pinntag-assets.s3.../Defaults/*` is a fake cover.
  It fails the gate correctly but hides businesses from Cover Backfill.
- **JWTs expire in 15 minutes.** Portal mislabels expired-token 401s as
  "Network Error."
- **Perfect is a filter, not a finish line.** Push what passes, fix the rest in
  waves.
- **Deterministic failures are bugs, not intelligence gaps.** Don't reach for
  an LLM to fix what a regex fix solves.

## Commands
```bash
# API
bash deploy/deploy-api.sh
ssh -i ~/.ssh/id_rsa ubuntu@107.23.203.205 "pm2 restart pinntag-dop-api --update-env"

# Portal (hard-refresh after)
bash deploy/deploy-portal.sh

# Bot source to S3 (bot self-updates from here)
bash deploy/upload-bot-source.sh

# Checks
cd apps/api && npx tsc --noEmit -p tsconfig.build.json
cd apps/portal && npm run build     # NOT tsc --noEmit

# Logs
ssh -i ~/.ssh/id_rsa ubuntu@107.23.203.205 "pm2 logs pinntag-dop-api --lines 200 --nostream"
```

`deploy-api.sh` does NOT auto-restart and does NOT rsync `.env`. Edit
`.env.production` directly on EC2 when needed.

## Infrastructure
- EC2 `107.23.203.205` — API pm2 `pinntag-dop-api` :3003, libpostal :4101
- `dop-api.pinntag.com` (API) · `dop.pinntag.com` (portal)
- Bot secret `pinntag_bot_2026`. Bot runs on **operator machines**, not EC2
  (centralizing raises CAPTCHA/block rates). Ubuntu 26.04 needs
  `channel="chrome"`.
- B2 media via `media-staging.pinntag.com`

## Business Console (`/businesses`)
The operational surface. Phase A (read-only) + Phase B (multiselect, actions,
runs) both shipped. Actions dispatch to existing services and execute
cursor-based in-process, returning a `runId` immediately.

Never add a purge or delete action to this page. `dedup_place_id` is permitted
only because deletion is internal to a guarded canonical-selection algorithm.

## Working style
- Terse. No filler, no meta-commentary. Report numbers, not narrative.
- Minimal targeted changes over rewrites.
- Reuse existing services; this codebase has more built than it looks.
- When a number looks wrong, STOP and explain it before proceeding.
- No em-dashes in any drafted email or message.
