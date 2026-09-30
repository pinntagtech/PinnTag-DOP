import mongoose from 'mongoose';

const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const MATCH_RADIUS_M = 150;

export interface BusinessMatch {
  businessId: string;
  name: string;
  distanceM: number;
  isClaimed: boolean | null;
  isSeeded: boolean;
  // 'attach' = safe to auto-attach at publish; 'manual_review' = claimed merchant
  action: 'attach' | 'manual_review';
}

export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Eligible for auto-attach: explicitly unclaimed, or seeded and not claimed.
export function isAttachEligible(b: {
  isClaimed?: boolean;
  isCvb?: boolean;
  isFromCrawler?: boolean;
}): boolean {
  if (b.isClaimed === true) return false;
  return b.isClaimed === false || b.isCvb === true || b.isFromCrawler === true;
}

// Name (case-insensitive exact) AND geo proximity, both required. READ-ONLY.
export async function findBusinessMatch(
  conn: mongoose.Connection,
  name: string,
  lat: number,
  lng: number,
): Promise<BusinessMatch | null> {
  if (!name?.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // ~150m bounding box prefilter (lat 1deg ~111km), exact distance via haversine.
  const dLat = MATCH_RADIUS_M / 111000;
  const dLng = MATCH_RADIUS_M / (111000 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  const cands = await conn
    .collection('businesses')
    .find({
      name: { $regex: new RegExp(`^${escapeRegex(name.trim())}$`, 'i') },
      isDeleted: { $ne: true },
      latitude: { $gte: lat - dLat, $lte: lat + dLat },
      longitude: { $gte: lng - dLng, $lte: lng + dLng },
    })
    .project({ name: 1, latitude: 1, longitude: 1, isClaimed: 1, isCvb: 1, isFromCrawler: 1, 'seedProvenance.isSeeded': 1 })
    .limit(20)
    .toArray();

  let best: BusinessMatch | null = null;
  for (const c of cands as any[]) {
    const d = haversineM(lat, lng, Number(c.latitude), Number(c.longitude));
    if (!(d <= MATCH_RADIUS_M) || (best && d >= best.distanceM)) continue;
    best = {
      businessId: String(c._id),
      name: c.name,
      distanceM: Math.round(d),
      isClaimed: typeof c.isClaimed === 'boolean' ? c.isClaimed : null,
      isSeeded: !!(c.seedProvenance?.isSeeded || c.isCvb || c.isFromCrawler),
      action: isAttachEligible(c) ? 'attach' : 'manual_review',
    };
  }
  return best;
}
