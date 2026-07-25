import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, RefreshCcw } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { useEnvironment } from '../contexts/EnvironmentContext';
import { FilterBar } from '../components/console/FilterBar';
import { GateFacets } from '../components/console/GateFacets';
import { BusinessRow } from '../components/console/BusinessRow';
import {
  useConsoleFacets,
  useConsoleSearch,
  useGateFreshness,
  useGateRecompute,
  type ConsoleFilter,
  type ConsoleSort,
  type GateCriterion,
  type GateOverall,
} from '../hooks/use-business-console';

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_SORT: ConsoleSort = { field: 'name', dir: 'asc' };

// URL <-> filter serialization. Only non-empty keys land in the URL so
// the query string stays readable, and the key drops entirely when the
// filter clears. Arrays are joined with ",".
function filterToParams(f: ConsoleFilter, sort: ConsoleSort, page: number) {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.state?.length) p.set('state', f.state.join(','));
  if (f.city?.length) p.set('city', f.city.join(','));
  if (typeof f.isActive === 'boolean') p.set('active', String(f.isActive));
  if (typeof f.hasWebsite === 'boolean')
    p.set('hasWebsite', String(f.hasWebsite));
  if (typeof f.hasEmail === 'boolean') p.set('hasEmail', String(f.hasEmail));
  if (f.duplicatePlaceIdOnly) p.set('dupPlaceId', '1');
  if (f.resolveHoursStatus?.length)
    p.set('hoursStatus', f.resolveHoursStatus.join(','));
  if (f.gateFails?.length) p.set('gateFails', f.gateFails.join(','));
  if (f.gatePasses?.length) p.set('gatePasses', f.gatePasses.join(','));
  if (f.gateOverall) p.set('gateOverall', f.gateOverall);
  if (sort.field !== DEFAULT_SORT.field) p.set('sortField', sort.field);
  if (sort.dir !== DEFAULT_SORT.dir) p.set('sortDir', sort.dir);
  if (page !== 1) p.set('page', String(page));
  return p;
}

function paramsToState(p: URLSearchParams): {
  filter: ConsoleFilter;
  sort: ConsoleSort;
  page: number;
} {
  const arr = (k: string): string[] | undefined => {
    const v = p.get(k);
    return v ? v.split(',').filter(Boolean) : undefined;
  };
  const bool = (k: string): boolean | undefined => {
    const v = p.get(k);
    if (v === 'true') return true;
    if (v === 'false') return false;
    return undefined;
  };
  return {
    filter: {
      q: p.get('q') || undefined,
      state: arr('state'),
      city: arr('city'),
      isActive: bool('active'),
      hasWebsite: bool('hasWebsite'),
      hasEmail: bool('hasEmail'),
      duplicatePlaceIdOnly: p.get('dupPlaceId') === '1' || undefined,
      resolveHoursStatus: arr('hoursStatus'),
      gateFails: (arr('gateFails') ?? undefined) as
        | GateCriterion[]
        | undefined,
      gatePasses: (arr('gatePasses') ?? undefined) as
        | GateCriterion[]
        | undefined,
      gateOverall: (p.get('gateOverall') as GateOverall) || null,
    },
    sort: {
      field: (p.get('sortField') as ConsoleSort['field']) || DEFAULT_SORT.field,
      dir: (p.get('sortDir') as ConsoleSort['dir']) || DEFAULT_SORT.dir,
    },
    page: Number(p.get('page')) || 1,
  };
}

function StatPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: string;
}) {
  return (
    <div
      style={{
        background: 'var(--surface-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '8px 12px',
        minWidth: '110px',
      }}
    >
      <div
        style={{
          fontSize: '10px',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '18px',
          fontWeight: 700,
          color: tone ?? 'var(--text)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const delta = Math.max(0, now - then);
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export default function BusinessConsolePage() {
  const { environment } = useEnvironment();
  const [searchParams, setSearchParams] = useSearchParams();

  const initial = useMemo(() => paramsToState(searchParams), [searchParams]);
  const [filter, setFilter] = useState<ConsoleFilter>(initial.filter);
  const [sort, setSort] = useState<ConsoleSort>(initial.sort);
  const [page, setPage] = useState<number>(initial.page);
  const [pageSize] = useState<number>(DEFAULT_PAGE_SIZE);

  // One-way state → URL. Hydration from URL is done once at mount above.
  useEffect(() => {
    const next = filterToParams(filter, sort, page);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, sort, page]);

  // Any filter change resets page to 1 — otherwise you can land on
  // page 12 of a query that only has 3.
  const updateFilter = useCallback(
    (next: ConsoleFilter) => {
      setFilter(next);
      setPage(1);
    },
    [setFilter, setPage],
  );

  const clearFilter = useCallback(() => {
    updateFilter({ gateOverall: null });
  }, [updateFilter]);

  const toggleGateFail = useCallback(
    (c: GateCriterion) => {
      const cur = new Set(filter.gateFails ?? []);
      if (cur.has(c)) cur.delete(c);
      else cur.add(c);
      const arr = Array.from(cur);
      updateFilter({ ...filter, gateFails: arr.length ? arr : undefined });
    },
    [filter, updateFilter],
  );

  const searchQuery = useConsoleSearch({
    environment,
    page,
    pageSize,
    sort,
    filter,
  });
  const facetsQuery = useConsoleFacets({ environment, filter });
  const freshnessQuery = useGateFreshness(environment);
  const recompute = useGateRecompute();

  const totalPages = Math.max(
    1,
    Math.ceil((searchQuery.data?.total ?? 0) / pageSize),
  );

  const sortHeader = (
    field: ConsoleSort['field'],
    label: string,
  ): React.ReactNode => {
    const active = sort.field === field;
    const nextDir = active && sort.dir === 'asc' ? 'desc' : 'asc';
    return (
      <button
        onClick={() => setSort({ field, dir: nextDir })}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          color: 'var(--text-muted)',
          fontSize: '10px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        {label}
        {active && <span>{sort.dir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <header>
        <h1
          style={{
            fontSize: '20px',
            fontWeight: 600,
            color: 'var(--text)',
            margin: 0,
          }}
        >
          Business Console
        </h1>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--text-secondary)',
            marginTop: '4px',
          }}
        >
          Every seeded business in <strong>{environment}</strong> with
          server-side search, filter, sort, and per-row verification links.
          Read-only in this phase — bulk actions land in Phase B.
        </p>
      </header>

      {/* Header stats + freshness */}
      <Card>
        <div
          style={{
            display: 'flex',
            gap: '10px',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <StatPill
              label="Total seeded"
              value={facetsQuery.data?.totals.total.toLocaleString() ?? '—'}
            />
            <StatPill
              label="Passes Legacy 9"
              value={
                facetsQuery.data?.totals.passLegacy9.toLocaleString() ?? '—'
              }
              tone="var(--green, #22c55e)"
            />
            <StatPill
              label="Passes Perfect 11"
              value={
                facetsQuery.data?.totals.passPerfect11.toLocaleString() ?? '—'
              }
              tone="var(--accent)"
            />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontSize: '12px',
              color: 'var(--text-muted)',
            }}
          >
            <span>
              Gate freshness:{' '}
              <strong style={{ color: 'var(--text-secondary)' }}>
                {formatRelative(
                  freshnessQuery.data?.oldestComputedAt ?? null,
                )}
              </strong>{' '}
              (oldest)
              {freshnessQuery.data?.ungatedCount ? (
                <span
                  style={{ marginLeft: '6px', color: 'var(--text-muted)' }}
                >
                  · {freshnessQuery.data.ungatedCount.toLocaleString()} never
                  gated
                </span>
              ) : null}
            </span>
            <Button
              variant="secondary"
              size="sm"
              loading={recompute.isPending}
              onClick={() => recompute.mutate({ environment })}
            >
              <RefreshCcw size={12} style={{ marginRight: '4px' }} /> Recompute
            </Button>
          </div>
        </div>
        {recompute.data && (
          <p
            style={{
              marginTop: '10px',
              fontSize: '11px',
              color: 'var(--text-muted)',
            }}
          >
            Last recompute: scanned {recompute.data.scanned.toLocaleString()},
            updated {recompute.data.updated.toLocaleString()},{' '}
            {recompute.data.duplicatePlaceIds.toLocaleString()} duplicate
            placeIds detected in {(recompute.data.durationMs / 1000).toFixed(1)}
            s.
          </p>
        )}
        {recompute.isError && (
          <p
            style={{
              marginTop: '10px',
              fontSize: '12px',
              color: 'var(--red)',
            }}
          >
            Recompute failed: {(recompute.error as Error).message}
          </p>
        )}
      </Card>

      {/* Facets */}
      <Card>
        <GateFacets
          facets={facetsQuery.data}
          selected={filter.gateFails ?? []}
          onToggle={toggleGateFail}
          loading={facetsQuery.isFetching}
        />
      </Card>

      {/* Filter bar */}
      <Card>
        <FilterBar
          filter={filter}
          onChange={updateFilter}
          onClear={clearFilter}
        />
      </Card>

      {/* Table */}
      <Card padding={false}>
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontFamily: 'var(--font)',
            }}
          >
            <thead>
              <tr style={{ background: 'var(--surface-elevated)' }}>
                <th
                  style={{
                    ...headerCell,
                    width: '52px',
                    textAlign: 'left',
                  }}
                >
                  Cover
                </th>
                <th style={headerCell}>{sortHeader('name', 'Name')}</th>
                <th style={headerCell}>{sortHeader('city', 'City / State')}</th>
                <th style={headerCell}>Gate</th>
                <th style={headerCell}>Status</th>
                <th style={headerCell}>Hours</th>
                <th style={headerCell}>Email</th>
                <th style={headerCell}>{sortHeader('placeId', 'placeId')}</th>
                <th style={headerCell}>Links</th>
              </tr>
            </thead>
            <tbody>
              {searchQuery.isLoading && (
                <tr>
                  <td
                    colSpan={9}
                    style={{
                      padding: '32px',
                      textAlign: 'center',
                      color: 'var(--text-muted)',
                      fontSize: '13px',
                    }}
                  >
                    Loading…
                  </td>
                </tr>
              )}
              {searchQuery.isError && (
                <tr>
                  <td
                    colSpan={9}
                    style={{
                      padding: '32px',
                      textAlign: 'center',
                      color: 'var(--red)',
                      fontSize: '13px',
                    }}
                  >
                    Search failed: {(searchQuery.error as Error).message}
                  </td>
                </tr>
              )}
              {!searchQuery.isLoading &&
                !searchQuery.isError &&
                searchQuery.data?.items.length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      style={{
                        padding: '32px',
                        textAlign: 'center',
                        color: 'var(--text-muted)',
                        fontSize: '13px',
                      }}
                    >
                      No seeded businesses match this filter.
                    </td>
                  </tr>
                )}
              {searchQuery.data?.items.map((row) => (
                <BusinessRow key={row._id} row={row} />
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '10px 14px',
            borderTop: '1px solid var(--border)',
            fontSize: '12px',
            color: 'var(--text-secondary)',
          }}
        >
          <span>
            {(searchQuery.data?.total ?? 0).toLocaleString()} results · page{' '}
            {page} of {totalPages}
          </span>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              style={pageBtn(page <= 1)}
            >
              <ChevronLeft size={12} />
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() =>
                setPage((p) => Math.min(totalPages, p + 1))
              }
              style={pageBtn(page >= totalPages)}
            >
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

const headerCell: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  fontSize: '10px',
  fontWeight: 600,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  borderBottom: '1px solid var(--border)',
};

const pageBtn = (disabled: boolean): React.CSSProperties => ({
  height: '26px',
  width: '26px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--surface-elevated)',
  color: disabled ? 'var(--text-muted)' : 'var(--text)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  opacity: disabled ? 0.5 : 1,
});
