// Extracts Overture Maps "places" theme rows for a bbox, via DuckDB +
// httpfs against the public overturemaps-us-west-2 S3 bucket. No writes,
// no auth (bucket is anonymous-read).
//
// Overture release is env-driven (OVERTURE_RELEASE, e.g. "2025-08-20.0")
// so operators can pin a known-good snapshot. Releases roll monthly-ish;
// see https://overturemaps.org for the current release listing. There is
// deliberately no baked-in fallback — an unpinned release across
// deploys would silently change the candidate set between runs.

import { Logger } from '@nestjs/common';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const duckdb = require('duckdb');

const log = new Logger('OvertureClient');

export interface OvertureBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface OvertureCandidate {
  sourceId: string; // Overture GERS id
  name: string;
  overtureCategory: string | null;
  lat: number;
  lng: number;
  address: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  postcode: string | null;
  websites: string[];
  phones: string[];
  confidence: number | null;
}

type DuckConn = { all: (sql: string, cb: (e: unknown, r: any[]) => void) => void; exec: (sql: string, cb: (e: unknown) => void) => void };
type DuckDb = { connect: () => DuckConn; close: (cb: (e: unknown) => void) => void };

function openDb(): DuckDb {
  return new duckdb.Database(':memory:');
}

function execP(conn: DuckConn, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function allP<T = any>(conn: DuckConn, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
  });
}

function closeP(db: DuckDb): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function fetchOverturePlacesInBbox(
  bbox: OvertureBbox,
): Promise<OvertureCandidate[]> {
  const release = process.env.OVERTURE_RELEASE;
  if (!release) {
    throw new Error(
      'OVERTURE_RELEASE env var not set — pin a snapshot before running discovery. ' +
        'Example: OVERTURE_RELEASE=2025-08-20.0',
    );
  }
  // Bbox sanity — refuse to query a global bbox by accident.
  if (
    bbox.east <= bbox.west ||
    bbox.north <= bbox.south ||
    bbox.east - bbox.west > 5 ||
    bbox.north - bbox.south > 5
  ) {
    throw new Error(
      `Refusing Overture pull for suspicious bbox: ${JSON.stringify(bbox)}`,
    );
  }

  const url = `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*`;
  const t0 = Date.now();
  const db = openDb();
  const conn = db.connect();

  try {
    await execP(conn, 'INSTALL httpfs;');
    await execP(conn, 'LOAD httpfs;');
    await execP(conn, "SET s3_region='us-west-2';");

    // bbox on Overture places is a struct { xmin, xmax, ymin, ymax } and
    // for a point-geometry row all four collapse to the same lng/lat pair.
    // Filtering on xmin/ymin alone is enough and lets DuckDB push the
    // predicate into parquet row-group statistics.
    const sql = `
      SELECT
        id,
        names.primary AS name,
        categories.primary AS category,
        bbox.xmin AS lng,
        bbox.ymin AS lat,
        addresses[1].freeform AS address,
        addresses[1].locality AS locality,
        addresses[1].region AS region,
        addresses[1].country AS country,
        addresses[1].postcode AS postcode,
        websites,
        phones,
        confidence
      FROM read_parquet('${url}', hive_partitioning=1)
      WHERE bbox.xmin >= ${bbox.west}
        AND bbox.xmin <= ${bbox.east}
        AND bbox.ymin >= ${bbox.south}
        AND bbox.ymin <= ${bbox.north}
    `;

    const rows = await allP<any>(conn, sql);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log.log(
      `Overture pull: release=${release} bbox=${JSON.stringify(bbox)} ` +
        `rows=${rows.length} in ${elapsed}s`,
    );

    return rows
      .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng))
      .map((r) => ({
        sourceId: String(r.id ?? ''),
        name: String(r.name),
        overtureCategory: r.category ? String(r.category) : null,
        lat: Number(r.lat),
        lng: Number(r.lng),
        address: r.address ? String(r.address) : null,
        locality: r.locality ? String(r.locality) : null,
        region: r.region ? String(r.region) : null,
        country: r.country ? String(r.country) : null,
        postcode: r.postcode ? String(r.postcode) : null,
        websites: Array.isArray(r.websites) ? r.websites.map(String) : [],
        phones: Array.isArray(r.phones) ? r.phones.map(String) : [],
        confidence:
          r.confidence === null || r.confidence === undefined
            ? null
            : Number(r.confidence),
      }));
  } finally {
    try {
      await closeP(db);
    } catch (e) {
      log.warn(`DuckDB close failed: ${(e as Error).message}`);
    }
  }
}
