#!/usr/bin/env bash
# dop-autopilot.sh — runs a queue of phase-prompt .md files through Claude Code
# headlessly, reviews each result with the Claude API, and auto-advances to
# the next phase UNLESS a hard gate fires (production, batch size, spend,
# first-run of new code) — in which case it stops and waits for you.
#
# Usage:
#   ./dop-autopilot.sh /path/to/pinntag-dop /path/to/phase-queue-dir
#
# Phase queue dir: numbered .md files, e.g. 01-phase4-pilot.md, 02-phase4-full.md
# Each gets sent to `claude -p` in order. Processed files move to done/.

set -euo pipefail

REPO="${1:?repo path required}"
QUEUE_DIR="${2:?phase queue dir required}"
DONE_DIR="$QUEUE_DIR/done"
LOG_DIR="$QUEUE_DIR/logs"
mkdir -p "$DONE_DIR" "$LOG_DIR"

# Hard gates: any of these strings appearing in the phase prompt OR the run
# output forces a stop, no matter what the reviewer decides. Extend as needed.
GATE_PATTERNS='production|pinntagProd|conflictMode.*overwrite|DROP|deleteMany|hard.delete|real spend|paid run|full.*(48|52),?[0-9]{3}|ROOT_ADMIN_PASSWORD|DOP_ADMIN_PASSWORD'

echo "=== DOP Autopilot starting: $(date) ==="
echo "Repo: $REPO"
echo "Queue: $QUEUE_DIR"
echo

for phase_file in "$QUEUE_DIR"/*.md; do
  [ -e "$phase_file" ] || { echo "Queue empty."; break; }
  name=$(basename "$phase_file")
  echo "--- Phase: $name ---"

  # Hard gate check on the prompt itself before even running it
  if grep -qiE "$GATE_PATTERNS" "$phase_file"; then
    echo "GATE: '$name' matches a hard-stop pattern. Not auto-running."
    echo "Review the file yourself and run it manually if it's safe to proceed:"
    echo "  (cd $REPO && claude -p \"\$(cat $phase_file)\" --output-format json)"
    exit 2
  fi

  run_log="$LOG_DIR/${name%.md}.$(date +%s).json"

  (cd "$REPO" && claude -p "$(cat "$phase_file")" \
    --output-format json \
    --allowedTools "Bash,Read,Edit,Write" \
    --permission-mode acceptEdits) \
    > "$run_log" 2> "$LOG_DIR/${name%.md}.stderr.log" || {
      echo "Claude Code run FAILED for $name. See $LOG_DIR/${name%.md}.stderr.log"
      exit 1
    }

  echo "Run complete. Output: $run_log"

  # Hard gate check on the OUTPUT too — code/logs can reveal a gate condition
  # that wasn't visible in the prompt (e.g. "eligible: 48,260 candidates").
  if grep -qiE "$GATE_PATTERNS" "$run_log"; then
    echo "GATE: run output for '$name' matches a hard-stop pattern."
    echo "Read $run_log yourself before deciding whether to continue."
    exit 2
  fi

  # Reviewer step — ask Claude API whether this looks clean to auto-advance
  review=$(node "$(dirname "$0")/review-gate.mjs" "$phase_file" "$run_log")
  decision=$(echo "$review" | node -e "process.stdin.once('data', d => console.log(JSON.parse(d).decision))")

  echo "Reviewer decision: $decision"

  if [ "$decision" != "CONTINUE" ]; then
    echo "$review" | node -e "process.stdin.once('data', d => console.log(JSON.parse(d).reason))"
    echo "Halting. Not auto-advancing to the next phase."
    exit 3
  fi

  mv "$phase_file" "$DONE_DIR/"
  echo "Advancing to next phase."
  echo
done

echo "=== Queue drained. All phases either completed or gated. ==="

