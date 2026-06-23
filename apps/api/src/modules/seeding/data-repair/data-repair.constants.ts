// Default regularTiming object used by the data-repair "FIX 1" path.
// Mon–Fri 09:00–17:00, Sat/Sun closed. Applied verbatim to any business
// whose regularTiming is missing or stored as a non-object (legacy
// `regularTiming: 0` rows).
//
// SHAPE — mirrors the real PinnTag main-backend Schedule:
//   regularTiming.weekDays.{day} = {
//     duration: {startHour,startMinute,endHour,endMinute} | null,
//     isClosed: boolean,
//   }
// Open days carry a duration and isClosed:false; closed days set
// duration:null and isClosed:true. Earlier DOP code wrote a flat
// shape (no weekDays nesting) with zero-duration objects for closed —
// the ~8,609 placeholder businesses written under that legacy shape
// will be migrated to this shape as they're resolved.
//
// Re-exported as a function so each repair gets its own object instance
// rather than a shared reference — keeps callers from accidentally
// mutating the canonical default.

const OPEN_9_TO_5_DURATION = {
  startHour: 9, startMinute: 0, endHour: 17, endMinute: 0,
};

function openDay(): Record<string, any> {
  return { duration: { ...OPEN_9_TO_5_DURATION }, isClosed: false };
}

function closedDay(): Record<string, any> {
  return { duration: null, isClosed: true };
}

export function defaultRegularTiming(): Record<string, any> {
  return {
    weekDays: {
      sunday: closedDay(),
      monday: openDay(),
      tuesday: openDay(),
      wednesday: openDay(),
      thursday: openDay(),
      friday: openDay(),
      saturday: closedDay(),
    },
  };
}

export const DATA_REPAIR_BATCH_SIZE = 50;

// Hard scope for every Data Repair query (across all five tabs:
// opening-hours, missing-outlets, activate-inactive, fix-taxonomy,
// fix-address). DOP must NEVER read or write an organically-created /
// owner-onboarded business — only ones the seeding pipeline produced.
// Both flags can identify a seeded business: `isCvb` (Convention &
// Visitors Bureau import) and `isFromCrawler` (Google-grid crawler).
// An OR between them captures all seeded sources.
export const SEEDED_ONLY: Record<string, any> = {
  $or: [{ isCvb: true }, { isFromCrawler: true }],
};

// AND the seeded-only scope into an existing filter. Appends to the
// caller's $and array (creating it if absent) so any prior $and / $or
// clauses are preserved verbatim. Defense-in-depth pattern: apply on
// every list, count, find, dry-run, and write (updateOne/updateMany)
// across the Data Repair surface — stale request bodies that name a
// non-seeded business id must reject at the query layer, not survive
// to mutate the doc.
export function andSeeded(
  filter: Record<string, any>,
): Record<string, any> {
  const existing = Array.isArray(filter.$and)
    ? (filter.$and as Record<string, any>[])
    : [];
  return { ...filter, $and: [...existing, SEEDED_ONLY] };
}
