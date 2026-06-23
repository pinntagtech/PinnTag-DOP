// LOCKED DECISION: "Open 24 hours" is encoded as 0:00–23:59 everywhere.
//
// Both hours parsers — the scraper adapter (import path) and this resolve
// path's hours-parser — MUST emit this identical duration for a 24-hour day
// so the two never diverge. Import this constant; do not re-declare the
// shape locally.
export const OPEN_24H_DURATION = {
  startHour: 0,
  startMinute: 0,
  endHour: 23,
  endMinute: 59,
} as const;
