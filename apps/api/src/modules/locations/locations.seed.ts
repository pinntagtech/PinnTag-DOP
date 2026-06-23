// Initial managed location list. Inserted once on bootstrap if the
// seedingLocations collection is empty. Each city carries a default
// state; areas may carry a `state` override (e.g. NYC's Jersey Side -> NJ).

export interface SeedAreaInput {
  name: string;
  subRegion?: string;
  state?: string;
}

export interface SeedCityInput {
  city: string;
  state: string;
  areas: SeedAreaInput[];
}

function plain(state: string, names: string[]): SeedAreaInput[] {
  return names.map((name) => ({ name }));
}

function withSubRegion(
  subRegion: string,
  names: string[],
  state?: string,
): SeedAreaInput[] {
  return names.map((name) => ({ name, subRegion, ...(state ? { state } : {}) }));
}

export const SEED_LOCATIONS: SeedCityInput[] = [
  {
    city: 'Atlanta',
    state: 'GA',
    areas: plain('GA', [
      'Midtown',
      'Downtown',
      'Buckhead',
      'Old Fourth Ward',
      'Virginia-Highland',
      'Inman Park',
      'West Midtown',
      'East Atlanta Village',
      'Atlantic Station',
      'Grant Park',
      'Decatur',
      'The Battery Atlanta',
    ]),
  },
  {
    city: 'Boston',
    state: 'MA',
    areas: plain('MA', [
      'Back Bay',
      'Seaport District',
      'North End',
      'Beacon Hill',
      'Fenway',
      'South Boston',
      'Downtown Crossing',
      'Cambridge',
      'Harvard Square',
      'Kendall Square',
      'Somerville',
      'Assembly Row',
    ]),
  },
  {
    city: 'Dallas',
    state: 'TX',
    areas: plain('TX', [
      'Uptown',
      'Deep Ellum',
      'Downtown Dallas',
      'Oak Lawn',
      'Knox-Henderson',
      'Bishop Arts District',
      'Lower Greenville',
      'Design District',
      'Trinity Groves',
      'Victory Park',
      'Addison',
      'Legacy West (Plano)',
    ]),
  },
  {
    city: 'Houston',
    state: 'TX',
    areas: plain('TX', [
      'Downtown',
      'Midtown',
      'Montrose',
      'River Oaks',
      'The Heights',
      'Galleria/Uptown',
      'Museum District',
      'EaDo',
      'Washington Avenue',
      'Rice Village',
      'Memorial',
      'Sugar Land Town Square',
    ]),
  },
  {
    city: 'Kansas City',
    state: 'MO',
    areas: plain('MO', [
      'Power & Light District',
      'Crossroads Arts District',
      'Country Club Plaza',
      'Westport',
      'River Market',
      'Brookside',
      'Waldo',
      'Downtown',
      '18th & Vine',
      'Crown Center',
      'Overland Park',
      'Prairie Village',
    ]),
  },
  {
    city: 'Los Angeles',
    state: 'CA',
    areas: plain('CA', [
      'Hollywood',
      'West Hollywood',
      'Beverly Hills',
      'Santa Monica',
      'Venice',
      'Downtown LA',
      'Koreatown',
      'Silver Lake',
      'Echo Park',
      'Arts District',
      'Pasadena',
      'Manhattan Beach',
    ]),
  },
  {
    city: 'Miami',
    state: 'FL',
    areas: plain('FL', [
      'South Beach',
      'Brickell',
      'Wynwood',
      'Downtown Miami',
      'Design District',
      'Coconut Grove',
      'Coral Gables',
      'Little Havana',
      'Edgewater',
      'Midtown Miami',
      'Aventura',
      'Sunny Isles Beach',
    ]),
  },
  {
    city: 'New York City',
    state: 'NY',
    areas: [
      ...withSubRegion('Manhattan', [
        'Times Square',
        'Midtown',
        'SoHo',
        'Tribeca',
        'Greenwich Village',
        'Chelsea',
        'Lower East Side',
        'Upper West Side',
        'Upper East Side',
        'Financial District',
      ]),
      ...withSubRegion('Brooklyn', [
        'Williamsburg',
        'DUMBO',
        'Brooklyn Heights',
        'Park Slope',
        'Greenpoint',
      ]),
      ...withSubRegion('Queens', [
        'Long Island City',
        'Astoria',
        'Flushing',
      ]),
    ],
  },
  {
    city: 'New Jersey',
    state: 'NJ',
    areas: [
      { name: 'Hoboken' },
      { name: 'Jersey City' },
      { name: 'Newport' },
      { name: 'Downtown Jersey City' },
    ],
  },
  {
    city: 'Philadelphia',
    state: 'PA',
    areas: plain('PA', [
      'Center City',
      'Old City',
      'Rittenhouse Square',
      'Fishtown',
      'Northern Liberties',
      'University City',
      'South Street',
      'Manayunk',
      'East Passyunk',
      'Chestnut Hill',
      'King of Prussia',
      'Conshohocken',
    ]),
  },
  {
    city: 'San Francisco Bay Area',
    state: 'CA',
    areas: [
      ...withSubRegion('San Francisco', [
        'Union Square',
        "Fisherman's Wharf",
        'Marina District',
        'Mission District',
        'Hayes Valley',
        'North Beach',
        'SoMa',
        'Castro',
      ]),
      ...withSubRegion('South Bay', [
        'Palo Alto',
        'Mountain View',
        'Santana Row',
        'Downtown San Jose',
        'Campbell',
      ]),
      ...withSubRegion('Peninsula', ['Redwood City', 'Burlingame']),
    ],
  },
  {
    city: 'Seattle',
    state: 'WA',
    areas: plain('WA', [
      'Downtown Seattle',
      'Capitol Hill',
      'Belltown',
      'South Lake Union',
      'Pioneer Square',
      'Fremont',
      'Ballard',
      'Queen Anne',
      'University District',
      'Bellevue Downtown',
      'Kirkland',
      'Redmond',
    ]),
  },
];
