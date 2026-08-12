// Shipped constants for the initial 10 discovery regions. Bounding boxes
// are deliberately conservative (city/county proper) — a bbox that spills
// into neighboring corpus can inflate Overture pulls without adding
// genuinely-new candidates. Widen later based on Atlanta pilot signal.
//
// Priority ranks the run order (lower = earlier). Atlanta at 1 is the
// pilot; NYC boroughs at 2 come next; the four NJ counties confirmed by
// Rahul (Bergen/Essex/Hudson/Union) at 3. The remaining NJ counties stay
// out until confirmed — do not add them here without sign-off.

export interface RegionSeedEntry {
  regionId: string;
  name: string;
  state: string;
  bbox: { west: number; south: number; east: number; north: number };
  priority: number;
}

export const REGION_SEED_DATA: RegionSeedEntry[] = [
  {
    regionId: 'atlanta-ga',
    name: 'Atlanta',
    state: 'GA',
    bbox: { west: -84.55, south: 33.65, east: -84.29, north: 33.89 },
    priority: 1,
  },
  {
    regionId: 'nyc-manhattan',
    name: 'Manhattan',
    state: 'NY',
    bbox: { west: -74.02, south: 40.70, east: -73.91, north: 40.88 },
    priority: 2,
  },
  {
    regionId: 'nyc-brooklyn',
    name: 'Brooklyn',
    state: 'NY',
    bbox: { west: -74.05, south: 40.57, east: -73.83, north: 40.74 },
    priority: 2,
  },
  {
    regionId: 'nyc-queens',
    name: 'Queens',
    state: 'NY',
    bbox: { west: -73.96, south: 40.54, east: -73.70, north: 40.80 },
    priority: 2,
  },
  {
    regionId: 'nyc-bronx',
    name: 'Bronx',
    state: 'NY',
    bbox: { west: -73.93, south: 40.79, east: -73.75, north: 40.92 },
    priority: 2,
  },
  {
    regionId: 'nyc-staten-island',
    name: 'Staten Island',
    state: 'NY',
    bbox: { west: -74.26, south: 40.48, east: -74.04, north: 40.65 },
    priority: 2,
  },
  {
    regionId: 'nj-bergen',
    name: 'Bergen County',
    state: 'NJ',
    bbox: { west: -74.24, south: 40.79, east: -73.89, north: 41.13 },
    priority: 3,
  },
  {
    regionId: 'nj-essex',
    name: 'Essex County',
    state: 'NJ',
    bbox: { west: -74.34, south: 40.66, east: -74.15, north: 40.90 },
    priority: 3,
  },
  {
    regionId: 'nj-hudson',
    name: 'Hudson County',
    state: 'NJ',
    bbox: { west: -74.13, south: 40.63, east: -73.99, north: 40.79 },
    priority: 3,
  },
  {
    regionId: 'nj-union',
    name: 'Union County',
    state: 'NJ',
    bbox: { west: -74.42, south: 40.55, east: -74.20, north: 40.75 },
    priority: 3,
  },
];
