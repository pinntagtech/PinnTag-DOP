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
      (dependent content on loser; buckets in `perGroup[i].dependentContent`)
      + 1 flagged because a loser is claimed/Stripe-backed. Operator must
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

## 4. Re-resolve — TODO (biggest single lever)

17,130 fail `real_hours`; ~8,341 sit at
`resolveStatus.hours: review:bot_error:no_search_match`. Also covers the
~1,269 records the city resync correctly skipped (malformed/absent
`addressLine1`) and the Harlem cluster with no address at all.

- [ ] Deterministic first: retry resolve with name + `addressLine1` (not
      name + city), libpostal-normalized (:4101), phone fallback, scraper
      artifacts stripped from name. Measure recovery from this alone.
- [ ] Only then consider LLM match adjudication on the residual
      Target: `real_hours` fails 17,130 → ?

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

- unique sparse index on Business.placeId
- addressLine1 validator: reject phone/URL/hours-text, require postal shape
- reject /Defaults/ placeholder covers on write
- derive city from addressLine1 at write time, never accept free-text
  Retires items 1, 2, and most of 4 permanently.

---

## Recovered but unmerged

Branch `recovered-stash` (commit `3dadccf`) holds Marketing Suite work
(`invitation-links.service.ts`, `pinntag-api.service.ts`,
`business-filter.service.ts`, `docs/marketing-api-reference.md`) thought lost.
Do not pop the stash. Extract specific paths only.
