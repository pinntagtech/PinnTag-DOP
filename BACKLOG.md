# DOP Backlog

Claude Code: work items top-down. For each, plan → dry-run → sample → apply →
verify → commit → report. Update status here as you go. Ask only for policy
calls and destructive decisions.

Status: `TODO` · `IN PROGRESS` · `BLOCKED` · `DONE`

---

## 1. Cover recovery — IN PROGRESS (code done; queueing is operator-paced)

3,971 seeded businesses hold placeholder `Defaults/*` covers, all with placeId.

- [x] Widen `coverlessFilter`, add `strip_placeholder_covers` action (f268555)
- [x] Stop emitting placeholder at 4 source sites (seed-defaults,
      post-publish, db-sync, migration) — 2e71a8c
- [x] Run strip, verify `countDocuments({cover:/Defaults\//})` → 0
      Confirmed on staging 2026-07-27: placeholderCoverSeeded=0.
- [ ] Queue `cover_sync` for the 3,971; bot throughput is the constraint.
      Coverless-with-placeId now 4,376 (includes docs that were always null).
      Operator runs `POST /seeding/cover-backfill/queue` in a loop.
      Target: `real_cover` fails 11,282 → ~7,300

## 2. Dedup — DONE (guard-blocked residue = 31 groups)

157 duplicate placeId groups in staging (was 621; partially run in July).

- [x] Dry-run `dedup_place_id` from the Console, confirmed 157
- [x] POLICY DECIDED — do not ask again.
      Keep existing scoring (cover 16 > hours 8 > taxonomy 4 > outlet 2 >
      oldest createdAt). Data quality wins; the record that renders best for
      users is canonical, regardless of cohort.
      ADD AN ABORT GUARD before deleting any loser: if the loser has dependent
      content the winner lacks — menus, files/gallery images, reviews, or a
      non-empty custom description — do NOT delete it. Skip it, count it as
      `flaggedManualReview`, and report those separately at the end.
      Rationale: crawler records usually win on cover/hours/taxonomy, which is
      correct. The real risk is silently destroying hand-curated content a
      seeder deliberately added. The guard catches that without blocking the
      other ~150 groups.
- [x] 5 sample cross-cohort groups printed at apply time (see session log)
- [x] Loop to `groupsProcessed: 0`
      Applied 2026-07-27. 12-sample apply (25 losers deleted) → full apply
      (114 groups processed, 208 losers deleted). Second dry-run reports
      groupsProcessed=0. totalSeeded 24,602 → 24,369.
- [ ] Add unique sparse index on `Business.placeId` AFTER dedup clears
      Blocked: 31 groups remain — 30 flagged `groupsFlaggedManualReview`
      (dependent content on loser; buckets in `perGroup[i].dependentContent`) + 1 flagged because a loser is claimed/Stripe-backed. Operator must
      manually resolve these 31 before the unique index can be added.
      Target: `singleton_placeId` fails 471 → 0

## 3. Missing outlets — BLOCKED

595 of 688 manual-seeder businesses have no active outlet, so they cannot
render in the consumer app regardless of data quality.
Blocked on: `DataRepairService.fixMissingOutlet` uses
`buildOutletBaseFromBusiness`, which copies the parent business address onto
the outlet. Outlets are distinct physical locations — that is wrong.

- [ ] Write a non-copying outlet-creation helper
- [ ] Wire `create_missing_outlet` to it
- [ ] Sample 10, verify outlet addresses are correct, then batch

## 4. Re-resolve hours — CORRECTED (diagnostic done)

Real distribution (24,602 seeded), BACKLOG's old 8,341 figure was stale:
null 14,999 ← the actual lever, never resolved
done 7,472
review:no_hours_captured 1,965
review:bot_error:no_search_match 107
other 59

TWO TRACKS, run both in parallel:

### 4a. Places API (fast path — hours only)

- [ ] Verify how many of the 14,999 nulls have a placeId
- [ ] Build PlacesApiResolveService: Place Details by placeId,
      field mask limited to opening_hours / current_opening_hours /
      business_status (Pro tier, ~$17 per 1,000)
- [ ] Concurrency ~50, staging-scoped, dry-run first, batched
- [ ] Records without a placeId fall through to Text Search (costlier)
- [ ] Write via the SAME hours encoding as the bot parser:
      0:00-23:59 = open all day, 0:00-0:00 + isClosed = closed
- Est. ~$300, ~30 min runtime for 15,000

### 4b. Bot (covers — API can't replace this cheaply)

- [ ] cover_sync for the 3,971
- [ ] Needs 8 operator machines to clear in 24h
- [ ] BLOCKED: fix item 9 first (Sumit's box failing on Chrome path)

### Also found

27 records have scraper garbage in addressLine1 ("cozyautomotive.com",
"Open 24 hours", "Your Maps history"). Sanitizer folds into item 10.
Strategy notes: libpostal-normalize is the winner (~51% clean parse);
phone as retry is cheap; name-artifact stripping is ~1% actionable, skip it.

## 5. Email scrape — TODO

`email_scrape` bot job shipped, never run at scale. Unlocks c10.

- [ ] Dry-run `/seeding/trigger/email-scrape` for candidate count
- [ ] Confirm `email_scraper.py` is in `deploy/upload-bot-source.sh` file list
      — if missing, operator bots will self-update `main.py` and fail on import
- [ ] Sample 15, verify each email is literally present on its `sourceUrl`
- [ ] Batch run

## 6. verified_name (c11) — TODO

No backing data; 24,602 fail by definition. Rule pass first: flag names
containing a URL, phone, ` - Google Maps`, `Permanently closed`, all-caps, or
name == address. Compare against the Google listing name from resolve.

## 7. Production push — TODO

Last confirmed `pinntagProd`: 3,635 `isFromCrawler:true`.

- [ ] Re-run gated preview for production; the old ~4,976 ceiling is stale
      (staging changed since: dedup, cohort widening, address fixes)
- [ ] Apply with a limit past covered ground; poll the DB count, not HTTP
- [ ] Note: the widened cohort means manual-seeder businesses are now eligible
      for the first time

## 8. Security — TODO

`DOP_ADMIN_PASSWORD` / `ROOT_ADMIN_PASSWORD` (`PinnTag123!`) and both Atlas
connection strings have been pasted in plaintext repeatedly across sessions.
Treat as compromised. Rotate.

## 9. Bot fix — TODO

`auto_setup_cookies.py` needs `channel="chrome"` + explicit `headless=False`
for Ubuntu 26.04 operator machines (Sumit, Abhishek). `main.py` already
patched.

BLOCKED until item 2 (dedup) reports groupsProcessed: 0. Whichever session
finishes item 2 should then pick this up automatically — verify duplicates
are 0 first, then proceed.

## 10. Schema hardening — stop the bleed

These cleanups exist because writes were unguarded. After items 1-4 land,
enforce at schema level so the next seed wave can't recreate them:

- [ ] unique sparse index on Business.placeId
      BLOCKED: 31 duplicate groups remain from item 2 (30 dependent-content
      manualReview + 1 claimed-loser). Operator must resolve them before
      the unique index can be applied.
- [x] addressLine1 validator: reject phone/URL/hours-text, require postal
      shape — `sanitizeBusinessPatch` in
      `apps/api/src/modules/seeding/common/business-write-guard.ts`.
      Wired into `buildSeededBusinessFields`, migration `logoCoverPatch`,
      and db-sync `computeBusinessSet`. Guard is drop-not-throw: invalid
      addressLine1 stays absent from the write instead of blocking the doc.
- [x] reject /Defaults/ placeholder covers on write — same helper strips
      cover/coverThumbnail/logo/logoThumbnail from any outbound patch.
      Belt-and-braces on top of the 4-site fix from item 1.
- [x] derive city from addressLine1 at write time, never accept free-text —
      same helper: when both addressLine1 (valid) and city are in a patch,
      city is coerced to the derived value.
      Retires items 1, 2, and most of 4 permanently.

---

## Recovered but unmerged

Branch `recovered-stash` (commit `3dadccf`) holds Marketing Suite work
(`invitation-links.service.ts`, `pinntag-api.service.ts`,
`business-filter.service.ts`, `docs/marketing-api-reference.md`) thought lost.
Do not pop the stash. Extract specific paths only.
## 11. Production placeId verification — HIGH PRIORITY, not yet started
2,126 of 11,532 production businesses (18.4%) have a placeId that has never
been confidence-scored against the actual Google listing. 0 have been
proven wrong so far (81.6% independently verified, 0 proven wrong) — but
"never checked" is not the same as "confirmed correct."

Discovered via: an Apify test batch of 100 staging placeIds returned 2
genuinely non-US results (New Delhi, Ghaziabad) for businesses whose STORED
coordinates said domestic. Proves placeId and coordinates can silently
disagree — domestic_coords alone does not catch this.

- [ ] Read-only resolve pass against the 2,126 unscored production placeIds
      (name-match + country check, same logic as staging resolve). No writes
      to production in this pass — flag mismatches only.
- [ ] Any flagged as non-US or provably-wrong: manual review before any
      corrective action. Do not auto-correct or auto-remove production data.
- [ ] Once closed, re-run this check as a standing quarterly job, not a
      one-time pass — placeIds can drift after future dedup/migration work,
      as this session's whole night proved.

## 12. Third-party bulk enrichment (Apify) — PARKED, needs a verification gate before use
Explored using Apify's Google Maps Scraper (compass/crawler-google-places)
to bulk-resolve the ~6,338 staging businesses where hours+address are the
ONLY remaining gate blocker (everything else already passes). Cost ~$6/1,000
(base $4 + mandatory place-details add-on $2, NOT the $1.50-4 headline rate).
~6,000 businesses ≈ ₹3,000 budget.

STOPPED before running the full batch: a 100-record test returned 2 results
for genuinely different businesses in India (New Delhi, Ghaziabad) despite
every input placeId belonging to a business already gate-verified as
domestic. Root cause unconfirmed — either those specific staging placeIds
are themselves wrong (same class of problem as item 11), or a
config/matching issue on the Apify side. NOT a leftover-search-field bug —
Apify's own docs confirm placeId input takes priority over search fields.

- [ ] Before resuming: build an import script with a HARD gate — reject any
      returned record where country != US, or where the returned name does
      not loose-match the stored name (reuse apps/bot/main.py's
      _names_loose_match, now shipped in a2c786b). Log rejects, never
      silently overwrite.
- [ ] Once the gate exists, the exported candidate list is ready:
      /tmp/apify-placeids.txt (6,000 placeIds) and
      /tmp/apify-target-businesses.json (businessId+placeId+name), scoped via
      export-apify-batch.js — only businesses where hours+address are the
      sole blocker, so a successful write flips them straight to
      fully-passing.
- [ ] Re-run the same 100-record test after the gate is built and confirm
      both bad results are correctly rejected before scaling to 6,000.

## Bot resolve fixes — status correction (context for above)
Two Claude Code sessions were needed to actually ship Fix 2 (name-match
loosening) and Fix 3 (query sanitizer) from recover-resolve-failures.md.

- Session 1 (commit 4c87b29): implemented Fix 1 (two-hop) for real. Fix 2/3
  were CLAIMED shipped and validated (95%/75%) but the diff only contained
  Fix 1. The validation harness re-implemented the sanitizer logic
  externally and tested THAT, not the actual bot code — a false-positive
  validation, caught by a live test against Golden Touch Wellness & Spa
  Center failing in the pre-fix way post-deploy.
- Session 2 (commit a2c786b): found and fixed the real gap. Fix 2/3 only
  existed API-side, not in the bot itself, and several enqueue paths
  (console run.service.ts, cover-backfill, direct /bot/poll callers) never
  passed through the code path that had them. Ported into apps/bot/main.py
  directly (_sanitize_query_fields, _names_loose_match), extended
  ScrapeRequest with address1/latitude/longitude, wired through every
  enqueue path. Live-verified on Golden Touch: now resolves correctly.
  20-record re-samples: no_search_match 95%/75% (hours), name_mismatch 65%
  hours, two_hop 15% (confirmed data ceiling, not a bug).
- LESSON: "committed and pushed" is not proof of "working." A prior
  session's own validation report is not trustworthy without an independent
  live check against a real, previously-failing record. Applied twice
  tonight, worth keeping as standing practice for any future bot/resolve
  work in this repo.

## Immediate next step given the above
Bot fix is now confirmed real and deployed (v2026.08.05.0115). The
requeue-flagged.js / requeue-flagged-insert.js pair from earlier tonight can
be re-run against the CURRENT bot code — the underlying jobs and priority
logic don't need to change, only the bot behind them does. Check
dop-pipeline / dop-prod-sync are both un-paused before assuming forward
progress.

## 13. Production merge path — CRITICAL, do not attempt overwrite as-is
Discovered 2026-08-05: conflictMode:'overwrite' in migration.service.ts does
a HARD DELETE + recreate (deleteOne then re-insert), not a field merge.
New _id every time. Of a 2000-placeId staging sample, 1838 already have an
active production subscription; 1 is claimed. Running overwrite at any real
scale would destroy live subscription/claim state with no rollback.

DO NOT run conflictMode:'overwrite' in bulk until a real merge path exists.

Needed: a genuine field-level update endpoint/mode that patches
regularTiming, addressLine1, cover, etc. on the EXISTING production
document — preserving _id, isClaimed, activeSubscription, outlets. Test on
a small manual batch (5-10 records) with before/after subscription-state
verification, same discipline as everything else in this log.

Also found: 16 duplicate placeId groups already in pinntagProd (from a
2000-record sample) — worth a cleanup pass, separate from the above.
