// Overture categories to drop from Phase 2 candidate pool. Deliberately
// tight — the sample run will surface false-drops so we can prune this
// list before the next widen. Rules of thumb:
//   - obvious non-consumer-app entries (residential, parking, landmarks)
//   - dwelling categories (accommodation covers hotels + apartments; hotels
//     are legitimate businesses, so we DON'T blocklist accommodation broadly
//     — only apartments/condominium/residential variants)
//   - null category is also dropped: without a taxonomy signal we can't
//     confidently gate a candidate, and Overture's null-category set skews
//     heavily toward addresses without a real business at them
//
// Anything not in this set falls through and is eligible for placeId
// resolution. Judgment (Phase 3) tightens further.

export const OVERTURE_CATEGORY_BLOCKLIST = new Set<string>([
  // Residential
  'apartments',
  'apartment_building',
  'apartment_complex',
  'condominium',
  'residential',
  'residential_building',
  'serviced_apartments',
  'housing_cooperative',
  // Community / civic (grey area — bring back individually if the sample
  // shows we're dropping legitimate community businesses)
  'community_center',
  'community_service_non_profit',
  // Infrastructure / landmarks
  'landmark_and_historical_building',
  'historic_site',
  'bridge',
  'mountain',
  'parking',
  'parking_lot',
  'parking_garage',
  'public_bathroom',
  'rest_area',
  'viewpoint',
  'monument',
  // Cemeteries / religious (funeral_home and church-as-business survive
  // in downstream filters; these are the pure landmark variants)
  'cemetery',
]);

export function isBlockedOvertureCategory(
  category: string | null | undefined,
): boolean {
  if (!category) return true; // null-category rows are dropped by rule
  return OVERTURE_CATEGORY_BLOCKLIST.has(category);
}
