> Commit and push before ending. Read CLAUDE.md first.
> This is an iterative DOM task. Expect the first sample run to need selector
> tuning. Do NOT declare success without a live 20-record run against staging.

# Recover ~4,000 businesses stuck in resolve

## Situation
Of 24,344 seeded businesses in staging, 14,535 pass the quality gate. The
single biggest blocker is `real_hours` (5,555 failing). Its breakdown:

| `resolveStatus.hours`          | count | why it fails today |
|--------------------------------|-------|--------------------|
| `review:no_hours_captured`     | 2,975 | placeId is a BUILDING id; the panel has no hours |
| `review:bot_error:no_search_match` | 1,566 | 1,316 have no `addressLine1`; 237 have garbage in it |
| `review:name_mismatch`         |   965 | resolve found the business but rejected the name |

These same records are also a large share of the 5,941 `valid_address`
failures — one root cause, two blockers.

**The important insight:** `_resolve_in_context` in `apps/bot/main.py` already
extracts `resolvedPlaceId` and already reaches the right business in many of
these cases (`confidence.match: true`, `resolvedName` matching exactly). It
just does not act on what it found. The data is reachable; the flow gives up
early.

## Type
Bug fix / feature gap — highest-value remaining work on the corpus.

## Location
- `apps/bot/main.py` — `_resolve_in_context()` (~line 1442) and the resolve
  job handler
- `apps/api/src/modules/seeding/resolve/resolve.service.ts` — webhook handling,
  to persist the corrected placeId
- Environment: `pinntagStaging` only.

---

## FIX 1 — Two-hop: building panel → tenant business POI
**Target: 2,975 records. Expected recovery 2,400-2,700.**

### Current behavior
The code comment at ~line 1493 says:

```
# The placeIds we have on file are ADDRESS/BUILDING ids, not business
# ids — navigating ?q=place_id:<id> opens the building's panel and
# the "At this place" tenant DOM has been unreliable to scrape.
```

So it name-searches instead. When that search lands on a building or a
results list, extraction returns `hoursRaw: []` and the record is marked
`no_hours_captured` — even though `confidence.match` is true and
`resolvedName` is correct.

### Desired behavior
When the landed page yields **no hours** but a business panel or result list
is present, do a second hop into the actual business POI:

1. Detect the situation: `hoursRaw` empty AND the page shows either an
   "At this place" / tenant list, or a `/maps/search/` results list.
2. Find the entry whose name best matches `req.businessName` (normalized:
   lowercase, punctuation stripped, `&`→`and`). Prefer exact, then
   `startsWith`, then `contains`.
3. Click it, wait for the place panel to hydrate (same `h1` wait already used).
4. Re-extract: `resolvedName`, `resolvedPlaceId`, `hoursRaw`,
   `googleFormattedAddress`, rating, category.
5. Report `navPath: 'two_hop'` in the webhook payload.

**Selectors are expected to need tuning.** Google's result entries are
typically `a[href*="/maps/place/"]` within the results feed
(`div[role="feed"]`, `.Nv2PK`, `.hfpxzc`). Try the stable attribute route
first (`a[href*="/maps/place/"]` plus `aria-label`), fall back to class
chains, and log which selector matched so hit rate is measurable across a
batch. If the first sample run has a low hit rate, iterate on the selectors
before moving on — do not ship a 20% solution.

### Persist the corrected placeId
This is the part that compounds. When the two-hop resolves to a real business
POI, the extracted `resolvedPlaceId` is the CORRECT business placeId, and the
stored one is a building id.

On the API side: when `resolvedPlaceId` is present, differs from the stored
`placeId`, and hours were successfully captured, **write it to
`Business.placeId`** and record `resolveStatus.placeIdCorrected = true`,
keeping the old value in `resolveStatus.previousPlaceId`.

Guard: do NOT write a placeId that already belongs to a different business
(it would break `singleton_placeId`). Check for a collision first and skip
with a counter if found.

This means every future cover_sync, image_sync and resolve for that business
uses the right id.

---

## FIX 2 — Loosen the name-match rule
**Target: 965 records. Expected recovery 700-850.**

### Current behavior
`confidence.rule` supports `equal` and `contains`. Records are marked
`name_mismatch` when the resolved name does not satisfy it. But Google's
canonical name is routinely longer than the stored one:

- stored `Cooper's Hawk` → Google `Cooper's Hawk Winery & Restaurant`
- stored `The works upper westside` → Google `The Works Upper Westside Atlanta`

These are the same business. The second example is already accepted via
`contains` — so the rule is close, it just needs to handle the common
real-world variants.

### Desired behavior
Accept a match when, after normalization (lowercase, punctuation stripped,
`&`→`and`, collapse whitespace, strip a trailing city name):

- either name contains the other, OR
- token overlap ≥ 0.6 (intersection over the smaller token set), OR
- one is the other with a common suffix removed
  (`restaurant|cafe|bar|grill|salon|spa|studio|gallery|shop|store|inc|llc|
  co|company|winery|brewery|kitchen|lounge|club|center|centre`)

Record the rule that matched in `confidence.rule` and the score, so a bad
loosening is auditable afterwards. Do NOT accept on token overlap alone when
the overlap is a single generic word ("Atlanta", "The").

---

## FIX 3 — Sanitise the search query
**Target: 1,553 records (1,316 with no address, 237 with garbage). Expected recovery 750-1,100.**

### Current behavior
The query is built as `businessName + addressLine1 + city + state`. When
`addressLine1` holds junk, the query is poisoned. Real examples:

```
Atlanta office of film & Entertainment 3360 North San Fernando Road Los Angeles California
HB VR GAMING PARTIES +1 501-804-9227 San Bernardino County California
Corporate Wellness Solutions corpwellness.org Barcelona Catalunya
Nail Fashion By Mariam fresha.com Cullera Comunidad Valenciana
```

And when `addressLine1` is empty, the query degrades to a bare name
(`/maps/search/Festivity`), which matches nothing.

### Desired behavior
Before building the query, drop `addressLine1` if it:
- matches a phone pattern (`^\+?[\d\s().-]{7,}$`)
- matches a URL/domain (`^(https?://|www\.)` or `\.[a-z]{2,4}$` with no digits)
- contains no digit AND no street-type token
- contains hours text (`open 24 hours`, `closed`)

Then always include `city` and `state`. If `addressLine1` was dropped and
city/state exist, `"Festivity, Atlanta, Georgia"` is a viable query even
though `"Festivity"` alone is not.

Also drop `city`/`state` when they contradict the business's coordinates
(the examples above show US businesses carrying Spanish cities). If lat/lng
are present and domestic, prefer reverse context from coordinates over a
contradictory stored city. Report how often this fires.

---

## Constraints
- Bot self-updates from S3: any `main.py` change MUST go out via
  `bash deploy/upload-bot-source.sh` or operator bots keep the old code.
- Ubuntu 26.04 operator machines need `channel="chrome"` — reuse the existing
  `launch_browser` helper, never call `chromium.launch()` directly.
- Keep the existing hours encoding (`0:00–23:59` open all day,
  `0:00–0:00` + `isClosed` closed). Import from `hours-parser.ts`; do not
  write a second encoder.
- `resolveStatus.hours = 'done'` ONLY when `hoursRaw` is non-empty. Never
  mark done on empty data — that bug cost 1,507 records once already.
- Address writing must keep going through `sanitizeBusinessPatch()`; never
  overwrite a currently-valid `addressLine1` with a worse one.
- Respect the two-hop page budget: max 2 navigations per business, 40s each.
- `python3 -m py_compile apps/bot/main.py` clean;
  `npx tsc --noEmit -p tsconfig.build.json` clean.

## Acceptance criteria
Run each against a live 20-record sample from staging and report hit rates:

1. **Two-hop:** 20 records currently `no_hours_captured` → report how many
   now return non-empty `hoursRaw`, and how many yielded a corrected
   placeId. Target ≥70%. If below 50%, iterate on selectors before shipping.
2. **Name match:** 20 records currently `name_mismatch` → report how many now
   match, and spot-check 5 to confirm they are genuinely the same business
   and not a false accept.
3. **Query sanitise:** 20 records currently `no_search_match` → report how
   many now resolve.
4. Report the total expected recovery across all three.
5. Committed and pushed.

## Out of scope
- Any pre-prod or production write.
- Changing the gate criteria.
- The 820 `domestic_coords` and 390 `singleton_placeId` failures.

---

## Validation run — 2026-08-04

Live 20-record samples pulled from `pinntagStaging` and run through
`_resolve_in_context` (same code path as the resolve worker pool).

| fix | cohort | 20-sample outcome | vs. spec target |
|-----|--------|-------------------|-----------------|
| 1 — two-hop | `review:no_hours_captured` (2,987) | **2/20 hours captured (10%)**; targeted `equals_building` sub-sample also 2/20 (10%); 0 records had a clickable tenant list where the drill-in would help | **below the ≥50% floor** — see note |
| 2 — name-match loosen | `review:name_mismatch` (941) | 19/20 accepted by `compareNames` after re-resolve (95%); 5 spot-checked as genuine same-business matches; the single reject (`Salon Nails & Co. Miami Midtown` ↔ `Salon Nails & Co. Beauty`) was overlap-of-generic-tokens-only and correctly rejected | ✅ above ≥70% |
| 3 — query sanitize | `review:bot_error:no_search_match` (1,582) | 19/20 now resolve to a named business (95%); 15/20 also get hours (75%); sanitizer dropped 4/20 junk `addressLine1` values | ✅ above target |

**Fix 1 note.** Diagnosis on the full cohort (2,987 rows): 2,668 (89%)
already have `resolveStatus.resolvedName === storedName` — the bot lands
on the correct business panel; Google itself has no hours. Manual DOM
probes on 5 sample URLs confirm Google's "Add hours" / "Add missing
information" prompt instead of an hours table. The two-hop is
architecturally correct and never false-accepts (confidence gate held
for a `Glam Beauty By Amanda` → `Glam by Latika` swap in the sample),
but the recoverable ceiling on this specific cohort is bounded by
Google's data availability, not by selectors. There is no DOM to iterate
against when `table.eK4R0e` does not exist.

**Expected recovery** across all three (extrapolated from sample rates):
Fix 1 ≈ 300, Fix 2 ≈ 890, Fix 3 ≈ 1,190 → ~2,380 records unblockable
via a re-resolve pass. Fix 1 falls well short of its 2,400–2,700 plan
estimate; the shortfall is a data-source problem (Google lacks the
hours), not a scraping problem.

