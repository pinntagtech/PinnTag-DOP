// Single source of truth for "which businesses are under DOP management".
//
// Historically the cohort was defined as `isCvb OR isFromCrawler`. That
// silently excluded businesses created by the internal data-seeding team
// (Surbhi/Vipin @yopmail.com accounts) via the target PinnTag app itself —
// those never receive the legacy flags because they don't pass through the
// DOP publish pipeline. The provenance-recompute job materializes
// `seedProvenance` onto every seeded doc so we can select the union with a
// single indexed predicate.
//
// Belt-and-braces: this filter is `seedProvenance.isSeeded:true` OR the
// legacy flags. Any doc missed by an out-of-date recompute (or predating
// the recompute entirely) still surfaces. Recompute WIDENS the set; it
// never unsets isSeeded on a legacy-flagged doc. So both paths are
// idempotent-safe additive: we can drop the legacy leg only once every
// deployed env has a fresh recompute — that's a later change.

export function buildSeededFilter(): Record<string, any> {
  return {
    $or: [
      { 'seedProvenance.isSeeded': true },
      { isCvb: true },
      { isFromCrawler: true },
    ],
  };
}

// Nested-shape MongoDB $or clause suitable for AND-ing into a compound
// filter. Same body as buildSeededFilter for now; kept as a separate name
// so callsites that AND multiple clauses read naturally.
export function seededCohortOrClause(): Record<string, any>[] {
  return [
    { 'seedProvenance.isSeeded': true },
    { isCvb: true },
    { isFromCrawler: true },
  ];
}
