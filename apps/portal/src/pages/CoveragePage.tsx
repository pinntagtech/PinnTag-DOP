import {
  Trophy,
  MapPin,
  Building2,
  Globe2,
  Activity,
  RefreshCcw,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { StatCard } from '../components/ui/StatCard';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { useCoverage, useRefreshCoverage } from '../hooks/use-coverage';
import type { CoverageSnapshot } from '@pinntag-dop/types';

// FIFA 2026 US host metros — fixed real-world reference (not a metric).
// Aliases are used to match against the live byCity buckets.
const HOST_METROS: {
  name: string;
  venue: string;
  state: string;
  aliases: string[];
}[] = [
  { name: 'New York / New Jersey', venue: 'MetLife Stadium', state: 'NJ',
    aliases: ['new york', 'jersey city', 'newark', 'east rutherford', 'nyc'] },
  { name: 'Los Angeles',           venue: 'SoFi Stadium',    state: 'CA',
    aliases: ['los angeles', 'inglewood', 'la'] },
  { name: 'Dallas',                venue: 'AT&T Stadium',    state: 'TX',
    aliases: ['dallas', 'arlington', 'fort worth'] },
  { name: 'San Francisco Bay',     venue: 'Levi’s Stadium',  state: 'CA',
    aliases: ['san francisco', 'santa clara', 'oakland', 'san jose'] },
  { name: 'Miami',                 venue: 'Hard Rock Stadium', state: 'FL',
    aliases: ['miami', 'miami gardens'] },
  { name: 'Atlanta',               venue: 'Mercedes-Benz Stadium', state: 'GA',
    aliases: ['atlanta'] },
  { name: 'Boston',                venue: 'Gillette Stadium', state: 'MA',
    aliases: ['boston', 'foxborough', 'foxboro'] },
  { name: 'Houston',               venue: 'NRG Stadium', state: 'TX',
    aliases: ['houston'] },
  { name: 'Kansas City',           venue: 'Arrowhead Stadium', state: 'MO',
    aliases: ['kansas city'] },
  { name: 'Philadelphia',          venue: 'Lincoln Financial Field', state: 'PA',
    aliases: ['philadelphia', 'philly'] },
  { name: 'Seattle',               venue: 'Lumen Field', state: 'WA',
    aliases: ['seattle'] },
];

const PIE_PALETTE = [
  '#4F46E5', '#7C3AED', '#0EA5E9', '#10B981', '#F59E0B',
  '#EF4444', '#EC4899', '#14B8A6', '#84CC16', '#F97316',
];

function describeArc(
  cx: number, cy: number, r: number, startAngle: number, endAngle: number,
): string {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function Donut({
  size = 160, thickness = 18, segments, centerLabel, centerSub,
}: {
  size?: number;
  thickness?: number;
  segments: { value: number; color: string; label: string }[];
  centerLabel: string;
  centerSub?: string;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - thickness) / 2;
  const total = Math.max(1, segments.reduce((s, x) => s + x.value, 0));
  let acc = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r}
        stroke="var(--surface-elevated)" strokeWidth={thickness} fill="none" />
      {segments.map((seg, i) => {
        if (seg.value <= 0) return null;
        const start = (acc / total) * 360;
        const end = ((acc + seg.value) / total) * 360;
        acc += seg.value;
        return (
          <path
            key={i}
            d={describeArc(cx, cy, r, start, end === 360 ? 359.999 : end)}
            stroke={seg.color}
            strokeWidth={thickness}
            fill="none"
            strokeLinecap="butt"
          />
        );
      })}
      <text x={cx} y={cy - 4} textAnchor="middle"
        fontSize={22} fontWeight={600} fill="var(--text)">
        {centerLabel}
      </text>
      {centerSub && (
        <text x={cx} y={cy + 16} textAnchor="middle"
          fontSize={10} fill="var(--text-muted)">
          {centerSub}
        </text>
      )}
    </svg>
  );
}

function Gauge({ pct }: { pct: number }) {
  const size = 180;
  const cx = size / 2;
  const cy = size / 2 + 8;
  const r = 70;
  const start = -120;
  const end = 120;
  const sweep = end - start;
  const v = Math.max(0, Math.min(100, pct));
  const valEnd = start + (sweep * v) / 100;
  const trackPath = describeArc(cx, cy, r, start, end);
  const valPath = describeArc(cx, cy, r, start, valEnd);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <path d={trackPath} stroke="var(--surface-elevated)"
        strokeWidth={14} fill="none" strokeLinecap="round" />
      <path d={valPath} stroke="#4F46E5"
        strokeWidth={14} fill="none" strokeLinecap="round" />
      <text x={cx} y={cy + 4} textAnchor="middle"
        fontSize={28} fontWeight={600} fill="var(--text)">
        {v}%
      </text>
      <text x={cx} y={cy + 24} textAnchor="middle"
        fontSize={10} fill="var(--text-muted)">
        Publish rate
      </text>
    </svg>
  );
}

function StackedBar({ data }: { data: CoverageSnapshot['byCity'] }) {
  const top = data.slice(0, 10);
  const max = Math.max(1, ...top.map((d) => d.total));
  const rowH = 28;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {top.map((d) => {
        const pubPct = (d.published / max) * 100;
        const pendPct = (d.pending / max) * 100;
        return (
          <div key={d.city} style={{ display: 'grid',
            gridTemplateColumns: '140px 1fr 80px', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {d.city}
              {d.state ? <span style={{ color: 'var(--text-muted)' }}> · {d.state}</span> : null}
            </span>
            <div style={{ display: 'flex', height: rowH,
              borderRadius: '4px', overflow: 'hidden',
              background: 'var(--surface-elevated)' }}>
              <div style={{ width: `${pubPct}%`, background: '#16A34A' }} />
              <div style={{ width: `${pendPct}%`, background: '#A78BFA' }} />
            </div>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)',
              fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
              {d.published}/{d.total}
            </span>
          </div>
        );
      })}
      {top.length === 0 && (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          No city-level data yet.
        </p>
      )}
    </div>
  );
}

function CityPie({ data }: { data: CoverageSnapshot['citySharePublished'] }) {
  const top = data.filter((d) => d.published > 0).slice(0, 8);
  const size = 200;
  const cx = size / 2;
  const cy = size / 2;
  const r = 86;
  if (top.length === 0) {
    return (
      <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
        No published records yet.
      </p>
    );
  }
  const total = top.reduce((s, x) => s + x.published, 0);
  let acc = 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {top.map((d, i) => {
          const start = (acc / total) * 360;
          const end = ((acc + d.published) / total) * 360;
          acc += d.published;
          const startPt = polarToCartesian(cx, cy, r, end);
          const endPt = polarToCartesian(cx, cy, r, start);
          const large = end - start <= 180 ? 0 : 1;
          return (
            <path
              key={d.city}
              d={`M ${cx} ${cy} L ${startPt.x} ${startPt.y}
                  A ${r} ${r} 0 ${large} 0 ${endPt.x} ${endPt.y} Z`}
              fill={PIE_PALETTE[i % PIE_PALETTE.length]}
              stroke="var(--surface)"
              strokeWidth={1}
            />
          );
        })}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column',
        gap: '4px', fontSize: '12px' }}>
        {top.map((d, i) => (
          <div key={d.city} style={{ display: 'flex',
            alignItems: 'center', gap: '6px' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2,
              background: PIE_PALETTE[i % PIE_PALETTE.length] }} />
            <span style={{ color: 'var(--text)' }}>{d.city}</span>
            <span style={{ color: 'var(--text-muted)',
              fontVariantNumeric: 'tabular-nums' }}>
              {d.published}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Match a host metro to byCity rows by alias substring + state.
function publishedForMetro(
  byCity: CoverageSnapshot['byCity'],
  metro: (typeof HOST_METROS)[number],
): number {
  const aliases = metro.aliases.map((a) => a.toLowerCase());
  let count = 0;
  for (const row of byCity) {
    const cityLc = (row.city || '').toLowerCase();
    if (!cityLc || cityLc === 'unknown') continue;
    const stateMatch = !row.state || row.state === metro.state;
    const aliasMatch = aliases.some((a) => cityLc.includes(a));
    if (aliasMatch && stateMatch) count += row.published;
  }
  return count;
}

export default function CoveragePage() {
  // Program-level view — independent of the env selector.
  const { data, isLoading } = useCoverage();
  const refresh = useRefreshCoverage();

  if (isLoading || !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px',
        width: '100%', minWidth: 0 }}>
        <Skeleton className="h-24" />
        <div style={{ display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)', gap: '20px' }}>
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-72" />
        <div style={{ display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px' }}>
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const live = data.totals.liveInProduction;
  const liveLabel = live === null ? '—' : live.toLocaleString();
  const liveSub = live === null ? 'unavailable' : 'in production DB';
  const publishedTotal = data.totals.published;
  const stagingCount = live === null
    ? null
    : Math.max(0, publishedTotal - live);

  const generatedAt = new Date(data.generatedAt);
  const lastUpdatedRelative = formatDistanceToNow(generatedAt, {
    addSuffix: true,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px',
      width: '100%', minWidth: 0 }}>
      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg, #312E81 0%, #4F46E5 100%)',
        color: '#ffffff',
        borderRadius: 'var(--radius-lg)',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Trophy size={18} />
            <h1 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>
              PinnTag · World Cup 2026 Coverage
            </h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '11px', opacity: 0.85 }}>
              Last updated {lastUpdatedRelative}
              {' · '}
              {generatedAt.toLocaleString()}
            </span>
            <Button
              variant="secondary"
              size="sm"
              loading={refresh.isPending}
              onClick={() => refresh.mutate()}
              style={{
                background: 'rgba(255,255,255,0.18)',
                color: '#ffffff',
                borderColor: 'rgba(255,255,255,0.35)',
              }}
              icon={<RefreshCcw size={12} />}
            >
              Refresh
            </Button>
          </div>
        </div>
        <p style={{ fontSize: '13px', opacity: 0.85, margin: 0 }}>
          Host-metro readiness across the 11 US venues. Live aggregate from
          seeding sessions.
        </p>
        <span style={{
          alignSelf: 'flex-start',
          fontSize: '11px',
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          background: 'rgba(255,255,255,0.18)',
          color: '#ffffff',
          padding: '4px 10px',
          borderRadius: '999px',
          marginTop: '4px',
        }}>
          Active Region: New York / New Jersey — Final at MetLife Stadium
        </span>
        {data.prodConnectionError && (
          <span style={{
            alignSelf: 'flex-start',
            fontSize: '11px',
            fontWeight: 500,
            background: 'rgba(239,68,68,0.25)',
            color: '#fff',
            padding: '4px 10px',
            borderRadius: '4px',
            marginTop: '4px',
          }}>
            Live-in-prod count unavailable: {data.prodConnectionError}
          </span>
        )}
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)', gap: '20px' }}>
        <StatCard
          label="Businesses Seeded"
          value={data.totals.seeded.toLocaleString()}
          sub={`${data.totals.citiesCovered} cities`}
          icon={<Building2 size={16} />}
        />
        <StatCard
          label="Published"
          value={data.totals.published.toLocaleString()}
          sub={`${data.totals.publishRate}% publish rate`}
          subVariant="success"
          icon={<Activity size={16} />}
          iconColor="var(--green)"
        />
        <StatCard
          label="Live in Production"
          value={liveLabel}
          sub={liveSub}
          subVariant={live === null ? 'error' : 'success'}
          icon={<Globe2 size={16} />}
          iconColor="#4F46E5"
        />
        <StatCard
          label="Cities Covered"
          value={data.totals.citiesCovered}
          sub="with any data"
          icon={<MapPin size={16} />}
        />
        <StatCard
          label="Host Metros"
          value={data.totals.hostMetros}
          sub="FIFA 2026 US venues"
          icon={<Trophy size={16} />}
          iconColor="#F59E0B"
        />
      </div>

      {/* Stacked bar by city */}
      <Card>
        <div style={{ display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline', marginBottom: '12px' }}>
          <h2 style={{ fontSize: '14px', fontWeight: 600,
            color: 'var(--text)', margin: 0 }}>
            Coverage by city — published vs pending
          </h2>
          <div style={{ display: 'flex', gap: '12px',
            fontSize: '11px', color: 'var(--text-muted)' }}>
            <span><span style={{ display: 'inline-block', width: 10,
              height: 10, background: '#16A34A',
              borderRadius: 2, marginRight: 4 }} />Published</span>
            <span><span style={{ display: 'inline-block', width: 10,
              height: 10, background: '#A78BFA',
              borderRadius: 2, marginRight: 4 }} />Pending</span>
          </div>
        </div>
        {/* TODO: goal-based denominator — currently total seeded per city.
            Swap to seedingLocations goals when that collection ships. */}
        <StackedBar data={data.byCity} />
      </Card>

      {/* Donut + Gauge + Pie */}
      <div style={{ display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px',
        alignItems: 'stretch' }}>
        <Card className="h-full flex flex-col">
          <h3 style={{ fontSize: '13px', fontWeight: 600,
            margin: '0 0 12px 0', color: 'var(--text)' }}>
            Prod vs Staging
          </h3>
          <div style={{ flex: 1, display: 'flex',
            alignItems: 'center', justifyContent: 'center', gap: '20px' }}>
            <Donut
              segments={
                live === null
                  ? [
                      { value: publishedTotal, color: '#A78BFA',
                        label: 'Published' },
                    ]
                  : [
                      { value: live, color: '#16A34A', label: 'Live' },
                      { value: stagingCount ?? 0, color: '#A78BFA',
                        label: 'Pre-prod / staging' },
                    ]
              }
              centerLabel={publishedTotal.toLocaleString()}
              centerSub="published"
            />
            <div style={{ fontSize: '12px',
              display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div><span style={{ display: 'inline-block', width: 10,
                height: 10, background: '#16A34A',
                borderRadius: 2, marginRight: 6 }} />
                Live in Prod:{' '}
                <strong>{live === null ? 'unavailable' : live}</strong></div>
              <div><span style={{ display: 'inline-block', width: 10,
                height: 10, background: '#A78BFA',
                borderRadius: 2, marginRight: 6 }} />
                Other envs:{' '}
                <strong>{stagingCount === null ? '—' : stagingCount}</strong></div>
            </div>
          </div>
        </Card>
        <Card className="h-full flex flex-col">
          <h3 style={{ fontSize: '13px', fontWeight: 600,
            margin: '0 0 12px 0', color: 'var(--text)' }}>
            Publish-rate gauge
          </h3>
          <div style={{ flex: 1, display: 'flex',
            alignItems: 'center', justifyContent: 'center' }}>
            <Gauge pct={data.totals.publishRate} />
          </div>
        </Card>
        <Card className="h-full flex flex-col">
          <h3 style={{ fontSize: '13px', fontWeight: 600,
            margin: '0 0 12px 0', color: 'var(--text)' }}>
            City share of published
          </h3>
          <div style={{ flex: 1, display: 'flex',
            alignItems: 'center' }}>
            <CityPie data={data.citySharePublished} />
          </div>
        </Card>
      </div>

      {/* Host-metro roadmap */}
      <Card>
        <h2 style={{ fontSize: '14px', fontWeight: 600,
          color: 'var(--text)', margin: '0 0 12px 0' }}>
          FIFA 2026 Host-Metro Coverage
        </h2>
        <div style={{ display: 'flex',
          flexDirection: 'column', gap: '6px' }}>
          {HOST_METROS.map((m, i) => {
            const count = publishedForMetro(data.byCity, m);
            const isActive = count > 0;
            return (
              <div key={m.name} style={{
                display: 'grid',
                gridTemplateColumns: '24px 1fr 200px 120px 80px',
                alignItems: 'center',
                gap: '12px',
                padding: '8px 10px',
                borderRadius: 'var(--radius-sm)',
                background: isActive
                  ? 'rgba(79,70,229,0.06)'
                  : 'transparent',
                border: isActive
                  ? '1px solid rgba(79,70,229,0.18)'
                  : '1px solid var(--border)',
              }}>
                <span style={{ fontSize: '12px',
                  color: 'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums' }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span style={{ fontSize: '13px',
                  fontWeight: 500, color: 'var(--text)' }}>
                  {m.name}
                </span>
                <span style={{ fontSize: '12px',
                  color: 'var(--text-secondary)' }}>
                  {m.venue}
                </span>
                <span style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  padding: '2px 8px',
                  borderRadius: '999px',
                  width: 'fit-content',
                  background: isActive ? '#DCFCE7' : '#F4F4F5',
                  color: isActive ? '#15803D' : '#71717A',
                }}>
                  {isActive ? 'Active' : 'Planned'}
                </span>
                <span style={{ fontSize: '12px',
                  fontVariantNumeric: 'tabular-nums',
                  textAlign: 'right',
                  color: isActive ? 'var(--text)' : 'var(--text-muted)' }}>
                  {count.toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
