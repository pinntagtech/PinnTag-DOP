/**
 * Standalone Launch Engagement bot.
 *
 * Runs as its own pm2 process (`dop-launch-engagement-bot`), NOT under
 * the Nest request-serving app. Reads process.env directly, opens one
 * persistent mongoose connection, ticks on a fixed interval.
 *
 * Each tick:
 *   1. Find businesses with { isLaunchEngagementBeta: true } in the
 *      target DB.
 *   2. For each, look at their published events from the last 72h.
 *   3. If a qualifying event has < 12 synthetic events already,
 *      write a small random batch of impressions / detail_views /
 *      (rare) saves tagged { source: 'launch_bot' } into
 *      `engagementevents`. Never sets `user`.
 *   4. Occasionally write a standalone profile_view (no event ref).
 *
 * Kill switch: setting `isLaunchEngagementBeta: false` on a business
 * causes it to be excluded from the next tick's query, immediately
 * halting new writes. Existing engagementevents docs are left in place.
 */

import mongoose, { Connection } from 'mongoose';

const VALID_ENVS = ['dev', 'pre-prod', 'staging', 'production'] as const;
type TargetEnv = (typeof VALID_ENVS)[number];

const ENV_TO_URI_VAR: Record<TargetEnv, string> = {
  dev: 'PINNTAG_DEV_MONGO_URI',
  'pre-prod': 'PINNTAG_PRE_PROD_MONGO_URI',
  staging: 'PINNTAG_STAGING_MONGO_URI',
  production: 'PINNTAG_PROD_MONGO_URI',
};

function fail(msg: string): never {
  console.error(`[launch-engagement-bot] ${msg}`);
  process.exit(1);
}

function resolveTargetEnv(): TargetEnv {
  const raw = process.env.LAUNCH_ENGAGEMENT_TARGET_ENV;
  if (!raw || !(VALID_ENVS as readonly string[]).includes(raw)) {
    fail(
      `LAUNCH_ENGAGEMENT_TARGET_ENV must be set to one of: ` +
        `${VALID_ENVS.join(', ')}. Got: ` +
        `${raw === undefined ? '<unset>' : JSON.stringify(raw)}. ` +
        `Refusing to default to any environment.`,
    );
  }
  return raw as TargetEnv;
}

function resolveTargetUri(env: TargetEnv): string {
  const override = process.env.LAUNCH_ENGAGEMENT_MONGO_URI;
  if (override) return override;

  const varName = ENV_TO_URI_VAR[env];
  const uri = process.env[varName];
  if (!uri) {
    fail(
      `${varName} is not set. Refusing to open a Mongo connection for ` +
        `env "${env}". Set ${varName} in the environment, or set ` +
        `LAUNCH_ENGAGEMENT_MONGO_URI to an explicit override URI.`,
    );
  }
  return uri;
}

const TARGET_ENV: TargetEnv = resolveTargetEnv();
const TARGET_URI: string = resolveTargetUri(TARGET_ENV);

const TICK_INTERVAL_MS = Number(
  process.env.LAUNCH_ENGAGEMENT_TICK_MS ?? 30 * 60 * 1000,
);

// Per-content-item ceiling so a single event doesn't accumulate a
// runaway synthetic count. Values are cadence targets, not per-tick maxes.
const PER_EVENT_SYNTHETIC_CEILING = 12;

// 72h lookback for "recent" content that gets synthetic engagement.
const RECENT_CONTENT_WINDOW_MS = 72 * 60 * 60 * 1000;

// Standalone profile_view frequency: roughly one per business every ~4
// ticks. Kept low so activity looks organic, not spammy.
const PROFILE_VIEW_TICK_PROBABILITY = 0.25;

const LOOSE_SCHEMA = new mongoose.Schema<any>(
  {},
  { strict: false, timestamps: true },
);

const EVENT_STATUS_PUBLISHED = 'published';

type EngagementType = 'impression' | 'detail_view' | 'profile_view' | 'save';

function randInt(minInclusive: number, maxInclusive: number): number {
  return Math.floor(
    Math.random() * (maxInclusive - minInclusive + 1) + minInclusive,
  );
}

function log(msg: string, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const suffix = extra
    ? ' ' +
      Object.entries(extra)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')
    : '';
  console.log(`[${ts}] [launch-engagement-bot] ${msg}${suffix}`);
}

async function tick(conn: Connection): Promise<void> {
  const Business = conn.model('Business', LOOSE_SCHEMA, 'businesses');
  const Event = conn.model('Event', LOOSE_SCHEMA, 'events');
  const EngagementEvent = conn.model(
    'EngagementEvent',
    LOOSE_SCHEMA,
    'engagementevents',
  );

  const flagged = (await Business.find({ isLaunchEngagementBeta: true })
    .select('_id name')
    .lean()) as Array<{ _id: mongoose.Types.ObjectId; name?: string }>;

  if (flagged.length === 0) {
    log('tick: no enrolled businesses');
    return;
  }

  const cutoff = new Date(Date.now() - RECENT_CONTENT_WINDOW_MS);
  let eventsWritten = 0;
  let businessesTouched = 0;

  for (const business of flagged) {
    const businessId = business._id;

    const recentContent = (await Event.find({
      businessProfile: businessId,
      status: EVENT_STATUS_PUBLISHED,
      createdAt: { $gte: cutoff },
    })
      .select('_id')
      .lean()) as Array<{ _id: mongoose.Types.ObjectId }>;

    const docs: Array<Record<string, unknown>> = [];

    for (const content of recentContent) {
      const existingSynthetic = await EngagementEvent.countDocuments({
        businessProfile: businessId,
        event: content._id,
        source: 'launch_bot',
      });
      if (existingSynthetic >= PER_EVENT_SYNTHETIC_CEILING) continue;

      const remaining = PER_EVENT_SYNTHETIC_CEILING - existingSynthetic;
      const impressionsThisTick = Math.min(randInt(0, 3), remaining);
      for (let i = 0; i < impressionsThisTick; i++) {
        docs.push(buildEvent(businessId, content._id, 'impression'));
      }

      const room = remaining - impressionsThisTick;
      if (room > 0 && Math.random() < 0.4) {
        docs.push(buildEvent(businessId, content._id, 'detail_view'));
      }
      if (room > 1 && Math.random() < 0.08) {
        docs.push(buildEvent(businessId, content._id, 'save'));
      }
    }

    if (Math.random() < PROFILE_VIEW_TICK_PROBABILITY) {
      docs.push(buildEvent(businessId, undefined, 'profile_view'));
    }

    if (docs.length > 0) {
      await EngagementEvent.insertMany(docs, { ordered: false });
      eventsWritten += docs.length;
      businessesTouched++;
    }
  }

  log('tick complete', {
    businessesEnrolled: flagged.length,
    businessesTouched,
    eventsWritten,
  });
}

function buildEvent(
  businessProfile: mongoose.Types.ObjectId,
  event: mongoose.Types.ObjectId | undefined,
  type: EngagementType,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    businessProfile,
    type,
    source: 'launch_bot',
  };
  if (event) doc.event = event;
  return doc;
}

async function main(): Promise<void> {
  log('starting', {
    targetEnv: TARGET_ENV,
    tickMs: TICK_INTERVAL_MS,
    perEventCeiling: PER_EVENT_SYNTHETIC_CEILING,
  });

  const conn = await mongoose.createConnection(TARGET_URI).asPromise();
  log('connected', { db: conn.db?.databaseName });

  let running = false;
  const runTick = async () => {
    if (running) {
      log('previous tick still in flight, skipping');
      return;
    }
    running = true;
    try {
      await tick(conn);
    } catch (err: any) {
      log('tick error', { message: err?.message ?? String(err) });
    } finally {
      running = false;
    }
  };

  await runTick();
  setInterval(runTick, TICK_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    log('shutdown', { signal });
    try {
      await conn.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[launch-engagement-bot] fatal', err);
  process.exit(1);
});
