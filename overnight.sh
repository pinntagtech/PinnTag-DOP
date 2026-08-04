#!/bin/bash
# overnight.sh — continuous, priority-ordered data correction pipeline.
#
# Loops forever:
#   1. recompute the gate (so progress is visible and priorities re-rank)
#   2. select businesses CLOSEST to passing
#   3. queue only the jobs they actually need
#   4. wait for drain, then repeat
#
# Priority: a business 1 job from passing outranks one that needs 2.
# Businesses blocked on something a bot cannot fix (taxonomy, outlet) are
# queued last, since no amount of scraping makes them pass.
#
# resolve_business fetches the Google Maps place page, which yields BOTH
# address and hours — so one job covers both deficits.
#
# 2026-08-05 patch: the bot's query sanitizer (a2c786b) reads address1 /
# latitude / longitude off the job document. This script previously queued
# jobs with only placeId + businessName, so every resolve fell back to the
# pre-fix broken query regardless of the bot code being current. Fixed by
# projecting and forwarding those three fields.
#
# Usage: nohup bash overnight.sh > /dev/null 2>&1 &
#
# .env.local (gitignored):
#   DOP_MONGO_URI       pinntagDOP     (dopBotJobs)
#   STAGING_MONGO_URI   pinntagStaging (businesses)
#   DOP_EMAIL / DOP_PASSWORD          (for gate recompute)
#   SLACK_WEBHOOK_URL

set -uo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source .env.local

API="https://dop-api.pinntag.com/api/v1"
LOG="$HOME/dop-overnight.log"
CYCLE=0

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

slack() {
  [ -z "${SLACK_WEBHOOK_URL:-}" ] && return 0
  curl -s -X POST -H 'Content-type: application/json' \
    --data "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$1")" \
    "$SLACK_WEBHOOK_URL" > /dev/null 2>&1
}

get_jwt() {
  JWT=$(curl -s -X POST "$API/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$DOP_EMAIL\",\"password\":\"$DOP_PASSWORD\"}" \
    | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("accessToken",""))
except Exception: print("")')
}

recompute_gate() {
  get_jwt
  [ -z "$JWT" ] && { log "auth failed, skipping recompute"; return 1; }
  curl -s -X POST "$API/seeding/console/gate/recompute" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT" \
    -d '{"environment":"staging"}' > /tmp/dop-recompute.json 2>&1
  log "gate recomputed"
}

log "=== continuous pipeline start ==="
slack ":crescent_moon: DOP pipeline started. Priority: businesses closest to production-ready first."

while true; do
  CYCLE=$((CYCLE + 1))
  log "--- cycle $CYCLE ---"

  # ---- 1. recompute gate so priorities reflect reality ----
  recompute_gate

  # ---- 2. select + report, ordered by distance from passing ----
  OUT=$(mongosh "$STAGING_MONGO_URI" --quiet --eval '
const SEEDED = { $or: [
  { "seedProvenance.isSeeded": true }, { isCvb: true }, { isFromCrawler: true }
]};

// Criteria a bot CANNOT fix. If any fail, scraping will not make it pass.
const NOT_BOT_FIXABLE_OK = {
  "gateStatus.c1_active_outlet": true,
  "gateStatus.c4_taxonomy_present": true,
  "gateStatus.c6_singleton_placeId": true,
  "gateStatus.c7_domestic_coords": true,
  "gateStatus.c9_verified_placeId": true
};

const HAS_PLACEID = { placeId: { $type: "string", $ne: "" } };
const PROJ = { _id: 1, name: 1, placeId: 1, addressLine1: 1, latitude: 1, longitude: 1,
  "gateStatus.c2_real_cover": 1, "gateStatus.c3_real_hours": 1,
  "gateStatus.c5_valid_address": 1 };

function fetch(q) {
  return db.businesses.find(Object.assign({}, SEEDED, HAS_PLACEID, q), PROJ).toArray();
}

// already passing everything -> nothing to do
const passing = db.businesses.countDocuments(
  Object.assign({}, SEEDED, { "gateStatus.passLegacy9": true }));

// unblocked = only bot-fixable deficits remain
const unblocked = fetch(Object.assign({}, NOT_BOT_FIXABLE_OK, {
  "gateStatus.passLegacy9": false
}));

// blocked = something non-bot-fixable is failing
const blocked = fetch({
  "gateStatus.passLegacy9": false,
  $or: [
    { "gateStatus.c1_active_outlet": false },
    { "gateStatus.c4_taxonomy_present": false },
    { "gateStatus.c6_singleton_placeId": false },
    { "gateStatus.c7_domestic_coords": false },
    { "gateStatus.c9_verified_placeId": false }
  ]
});

function jobsFor(b) {
  const g = b.gateStatus || {};
  const needResolve = (g.c3_real_hours === false) || (g.c5_valid_address === false);
  const needCover   = (g.c2_real_cover === false);
  return { needResolve: needResolve, needCover: needCover,
           count: (needResolve ? 1 : 0) + (needCover ? 1 : 0) };
}

const p1 = [], p2 = [], p3 = [];
unblocked.forEach(function (b) {
  const j = jobsFor(b);
  b._jobs = j;
  if (j.count === 1) p1.push(b);
  else if (j.count >= 2) p2.push(b);
});
blocked.forEach(function (b) { b._jobs = jobsFor(b); if (b._jobs.count > 0) p3.push(b); });

print("PASSING " + passing);
print("P1 " + p1.length);
print("P2 " + p2.length);
print("P3 " + p3.length);
print("JSON_START");
print(JSON.stringify({ p1: p1, p2: p2, p3: p3 }));
' 2>/dev/null)

  PASSING=$(echo "$OUT" | grep '^PASSING ' | awk '{print $2}')
  P1=$(echo "$OUT" | grep '^P1 ' | awk '{print $2}')
  P2=$(echo "$OUT" | grep '^P2 ' | awk '{print $2}')
  P3=$(echo "$OUT" | grep '^P3 ' | awk '{print $2}')
  PASSING=${PASSING:-0}; P1=${P1:-0}; P2=${P2:-0}; P3=${P3:-0}

  echo "$OUT" | sed -n '/JSON_START/,$p' | tail -1 > /tmp/dop-candidates.json

  if [ ! -s /tmp/dop-candidates.json ]; then
    log "could not read staging; retrying in 5 min"
    slack ":warning: DOP pipeline: staging read failed, retrying."
    sleep 300
    continue
  fi

  log "passing=$PASSING p1=$P1 p2=$P2 p3=$P3"

  if [ "$P1" -eq 0 ] && [ "$P2" -eq 0 ] && [ "$P3" -eq 0 ]; then
    slack ":white_check_mark: DOP pipeline: nothing left to queue. Passing = *$PASSING*."
    log "nothing to queue, exiting"
    break
  fi

  # ---- 3. queue, skipping anything already in flight ----
  INS=$(mongosh "$DOP_MONGO_URI" --quiet --eval '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync("/tmp/dop-candidates.json","utf8"));
let seq = 0, added = 0, skipped = 0;

// Do not re-queue a business we already handled.
const live = {};
const CUTOFF = new Date(Date.now() - 2 * 60 * 60 * 1000);

// 1. currently queued or running
db.dopBotJobs.find(
  { status: { $in: ["pending","running"] } },
  { businessId: 1, type: 1 }
).forEach(function (j) { live[j.businessId + "|" + j.type] = 1; });

// 2. finished within the last 2h - give it a cooldown
db.dopBotJobs.find(
  { status: { $in: ["done","failed"] }, completedAt: { $gt: CUTOFF } },
  { businessId: 1, type: 1 }
).forEach(function (j) { live[j.businessId + "|" + j.type] = 1; });

// 3. tried 5+ times already - it is not going to work on the 6th
db.dopBotJobs.aggregate([
  { $match: { status: { $in: ["done","failed"] } } },
  { $group: { _id: { b: "$businessId", t: "$type" }, n: { $sum: 1 } } },
  { $match: { n: { $gte: 5 } } }
], { allowDiskUse: true }).forEach(function (r) {
  live[r._id.b + "|" + r._id.t] = 1;
});

function queue(list, type) {
  const docs = [];
  (list || []).forEach(function (b) {
    const key = String(b._id) + "|" + type;
    if (live[key]) { skipped++; return; }
    docs.push({
      placeId: b.placeId,
      businessId: String(b._id),
      businessName: b.name || "",
      address1: b.addressLine1 || "",
      latitude: (typeof b.latitude === "number") ? b.latitude : null,
      longitude: (typeof b.longitude === "number") ? b.longitude : null,
      environment: "staging",
      sessionId: "000000000000000000000000",
      type: type,
      status: "pending",
      attempts: 0,
      createdAt: new Date(Date.now() + (seq++)),
      pipelinePriority: true
    });
    live[key] = 1;
  });
  for (let i = 0; i < docs.length; i += 500) {
    db.dopBotJobs.insertMany(docs.slice(i, i + 500), { ordered: false });
  }
  added += docs.length;
}

// P1 first: one job from passing. Then P2. P3 last.
[["p1"],["p2"],["p3"]].forEach(function (t) {
  const tier = c[t[0]] || [];
  queue(tier.filter(function (b) { return b._jobs && b._jobs.needResolve; }), "resolve_business");
  queue(tier.filter(function (b) { return b._jobs && b._jobs.needCover;   }), "cover_sync");
});

print(added + " " + skipped);
' 2>/dev/null | tail -1)

  read -r ADDED SKIPPED <<< "$INS"
  ADDED=${ADDED:-0}; SKIPPED=${SKIPPED:-0}
  log "queued $ADDED (skipped $SKIPPED already in flight)"
  slack ":inbox_tray: Cycle $CYCLE — passing *$PASSING* · queued *$ADDED* jobs (P1 $P1 · P2 $P2 · P3 $P3)"

  # ---- 4. wait for drain, reporting as we go ----
  STALL=0
  while true; do
    sleep 900

    STATS=$(mongosh "$DOP_MONGO_URI" --quiet --eval '
      const p=db.dopBotJobs.countDocuments({status:"pending"});
      const r=db.dopBotJobs.countDocuments({status:"running"});
      const d=db.dopBotJobs.countDocuments({status:"done"});
      const f=db.dopBotJobs.countDocuments({status:"failed"});
      const h=db.dopBotJobs.countDocuments({status:"done",completedAt:{$gt:new Date(Date.now()-900000)}});
      print(p+" "+r+" "+d+" "+f+" "+h);
    ' 2>/dev/null | tail -1)

    read -r PEND RUN DONE FAIL L15 <<< "$STATS"
    PEND=${PEND:-0}; RUN=${RUN:-0}; L15=${L15:-0}; DONE=${DONE:-0}; FAIL=${FAIL:-0}

    RATE=$((L15 * 4))
    if [ "$RATE" -gt 0 ]; then ETA="~$((PEND / RATE))h"; else ETA="STALLED"; fi
    log "pending=$PEND running=$RUN done=$DONE failed=$FAIL 15m=$L15 ($ETA)"
    slack ":robot_face: pending *$PEND* · running *$RUN* · done *$DONE* · failed *$FAIL* · 15m *$L15* · $ETA"

    if [ "$PEND" -eq 0 ] && [ "$RUN" -eq 0 ]; then
      log "drained, next cycle"
      break
    fi

    if [ "$L15" -eq 0 ]; then
      STALL=$((STALL + 1))
      if [ "$STALL" -ge 3 ]; then
        slack ":rotating_light: No completions in 45 min. Check the bot. pending=$PEND"
        STALL=0
      fi
    else
      STALL=0
    fi
  done
done

log "=== pipeline end ==="
