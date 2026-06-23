import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Globe,
  Sparkles,
} from 'lucide-react';
import type { Environment } from '@pinntag-dop/types';
import { apiClient } from '../lib/api-client';
import { Button } from '../components/ui/Button';

// ─── API response shapes ─────────────────────────────────────────────────

interface ResolveCandidateRow {
  _id: string;
  name?: string;
  addressLine1?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  placeId?: string | null;
  regularTimingIsPlaceholder: boolean;
  hasRegularTiming: boolean;
  resolveStatus?: {
    status?: 'done' | 'review';
    reason?: string;
    checkedAt?: string;
  } | null;
}

interface CandidatesResponse {
  businesses: ResolveCandidateRow[];
  total: number;
  page: number;
  pages: number;
}

interface ReviewRow {
  _id: string;
  name?: string;
  city?: string;
  state?: string;
  placeId?: string | null;
  resolveStatus: {
    status: 'review';
    reason?: string;
    resolvedName?: string;
    resolvedPlaceId?: string | null;
    hoursRaw?: string[];
    checkedAt?: string;
  };
}

interface ReviewResponse {
  businesses: ReviewRow[];
  total: number;
  page: number;
  pages: number;
}

type Tab = 'candidates' | 'review';

const ENV_OPTIONS: { value: Environment; label: string }[] = [
  { value: 'production', label: 'Production' },
  { value: 'staging', label: 'Staging' },
  { value: 'pre-prod', label: 'Pre-prod' },
  { value: 'dev', label: 'Dev' },
];

export default function ResolveBusinessPage() {
  const [targetEnv, setTargetEnv] = useState<Environment>('staging');
  const [tab, setTab] = useState<Tab>('candidates');

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '20px',
          gap: '16px',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1
            style={{
              fontSize: '20px',
              fontWeight: 600,
              color: 'var(--text)',
              margin: 0,
            }}
          >
            Resolve from Google
          </h1>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--text-secondary)',
              marginTop: '4px',
            }}
          >
            Fetch authentic placeId + opening hours from Google Maps,
            one visit per business. Select first, test small.
          </p>
        </div>

        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '12px',
            color: 'var(--text-secondary)',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '6px 10px',
          }}
        >
          <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Target DB
          </span>
          <select
            value={targetEnv}
            onChange={(e) => setTargetEnv(e.target.value as Environment)}
            style={{
              background: 'transparent',
              color: 'var(--text)',
              border: 'none',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            {ENV_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <CoverB2SyncBanner environment={targetEnv} />

      <div
        style={{
          display: 'flex',
          gap: '4px',
          borderBottom: '1px solid var(--border)',
          marginBottom: '16px',
        }}
      >
        <TabButton
          active={tab === 'candidates'}
          icon={<Globe size={14} />}
          label="Candidates"
          onClick={() => setTab('candidates')}
        />
        <TabButton
          active={tab === 'review'}
          icon={<AlertTriangle size={14} />}
          label="Needs review"
          onClick={() => setTab('review')}
        />
      </div>

      {tab === 'candidates' && <CandidatesTab environment={targetEnv} />}
      {tab === 'review' && <ReviewTab environment={targetEnv} />}
    </div>
  );
}

// ─── Tab 1: Candidates ───────────────────────────────────────────────────

interface Filters {
  search: string;
  city: string;
  state: string;
}

const EMPTY_FILTERS: Filters = { search: '', city: '', state: '' };

function CandidatesTab({ environment }: { environment: Environment }) {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const limit = 25;

  // Selection: per-row + "select all filtered" (mirrors the staging→prod
  // pattern). selectAllFiltered tells the trigger to expand to the
  // whole filtered set via a follow-up server-side fetch.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllFiltered, setSelectAllFiltered] = useState(false);

  const [enqueuedBanner, setEnqueuedBanner] = useState<number | null>(null);

  // Result banner for the bulk "Re-resolve flagged & unresolved" path.
  // Carries `created` + `remaining` so the operator knows whether to
  // click again to drain the rest of the queue.
  const [retriggerResult, setRetriggerResult] = useState<
    { created: number; remaining: number } | null
  >(null);
  const [retriggerPending, setRetriggerPending] = useState(false);

  const queryParams = useMemo(() => {
    const params: Record<string, string> = {
      environment,
      page: String(page),
      limit: String(limit),
    };
    if (filters.search) params.search = filters.search;
    if (filters.city) params.city = filters.city;
    if (filters.state) params.state = filters.state;
    return params;
  }, [environment, filters, page]);

  const listQuery = useQuery({
    queryKey: ['resolve-candidates', queryParams],
    queryFn: async () => {
      const { data } = await apiClient.get<CandidatesResponse>(
        '/seeding/resolve-business/candidates',
        { params: queryParams },
      );
      return data;
    },
    // Auto-refetch while resolves may be in flight — picks up
    // resolveStatus updates as the webhook lands.
    refetchInterval:
      enqueuedBanner || retriggerResult ? 5000 : false,
  });

  const rows = listQuery.data?.businesses ?? [];
  const total = listQuery.data?.total ?? 0;
  const pages = listQuery.data?.pages ?? 1;

  const onFilterChange = (next: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...next }));
    setPage(1);
    setSelectedIds(new Set());
    setSelectAllFiltered(false);
  };

  const togglePageRow = (id: string) => {
    setSelectAllFiltered(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePageAll = () => {
    setSelectAllFiltered(false);
    setSelectedIds((prev) => {
      const allOnPageSelected = rows.every((r) => prev.has(r._id));
      const next = new Set(prev);
      if (allOnPageSelected) {
        rows.forEach((r) => next.delete(r._id));
      } else {
        rows.forEach((r) => next.add(r._id));
      }
      return next;
    });
  };

  const selectionCount = selectAllFiltered ? total : selectedIds.size;

  // For "select all filtered", we need the actual ID list. The list
  // endpoint paginates, so we fetch every page on demand.
  const collectAllFilteredIds = async (): Promise<string[]> => {
    const ids: string[] = [];
    const pageSize = 100;
    let p = 1;
    while (true) {
      const { data } = await apiClient.get<CandidatesResponse>(
        '/seeding/resolve-business/candidates',
        {
          params: {
            ...queryParams,
            page: String(p),
            limit: String(pageSize),
          },
        },
      );
      data.businesses.forEach((b) => ids.push(b._id));
      if (p >= data.pages || data.businesses.length === 0) break;
      p += 1;
    }
    return ids;
  };

  const [pendingFix, setPendingFix] = useState<{
    count: number;
  } | null>(null);

  // Retrigger-review confirm dialog uses the same modal in a "retrigger"
  // variant — body copy is different (full work-set, up-to-1000-per-click)
  // but the env-coloured banner + cancel/confirm chrome are identical.
  const [pendingRetrigger, setPendingRetrigger] = useState(false);

  const triggerMutation = useMutation({
    mutationFn: async () => {
      const businessIds = selectAllFiltered
        ? await collectAllFilteredIds()
        : [...selectedIds];
      const { data } = await apiClient.post<{
        created: number;
        skippedAlreadyDone: number;
      }>(
        '/seeding/resolve-business/trigger',
        { environment, businessIds },
      );
      return data;
    },
    onSuccess: (data) => {
      setEnqueuedBanner(data.created);
      setSelectedIds(new Set());
      setSelectAllFiltered(false);
      setPendingFix(null);
      qc.invalidateQueries({ queryKey: ['resolve-candidates'] });
    },
  });

  const retriggerMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<{
        created: number;
        remaining: number;
        batchId?: string;
      }>('/seeding/resolve-business/retrigger-review', { environment });
      return data;
    },
    onMutate: () => {
      setRetriggerPending(true);
    },
    onSettled: () => {
      setRetriggerPending(false);
    },
    onSuccess: (data) => {
      setRetriggerResult({
        created: data.created,
        remaining: data.remaining,
      });
      setPendingRetrigger(false);
      qc.invalidateQueries({ queryKey: ['resolve-candidates'] });
    },
  });

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '12px',
          flexWrap: 'wrap',
          gap: '8px',
        }}
      >
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          {total.toLocaleString()} authentic candidate
          {total === 1 ? '' : 's'} in {environment}. Start with ~10
          and review outcomes before resolving more.
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Button
            variant="primary"
            size="sm"
            icon={<Sparkles size={13} />}
            disabled={selectionCount === 0 || triggerMutation.isPending}
            loading={triggerMutation.isPending}
            onClick={() => setPendingFix({ count: selectionCount })}
          >
            Fix selected ({selectionCount.toLocaleString()})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<AlertTriangle size={13} />}
            disabled={retriggerPending}
            loading={retriggerPending}
            onClick={() => setPendingRetrigger(true)}
          >
            Re-resolve flagged &amp; unresolved
          </Button>
        </div>
      </div>

      {enqueuedBanner !== null && (
        <div
          style={{
            background: 'var(--accent-subtle)',
            border: '1px solid var(--accent)',
            color: 'var(--text)',
            borderRadius: 'var(--radius)',
            padding: '10px 14px',
            marginBottom: '12px',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>
            Enqueued {enqueuedBanner.toLocaleString()} fix jobs. Each
            business gets one bot visit, then the server auto-applies
            mapped taxonomies and syncs covers. Already-fully-fixed
            businesses are skipped automatically.
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEnqueuedBanner(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {retriggerResult !== null && (
        <div
          style={{
            background:
              retriggerResult.remaining > 0
                ? 'var(--amber-subtle)'
                : 'var(--accent-subtle)',
            border: `1px solid ${
              retriggerResult.remaining > 0
                ? 'var(--amber)'
                : 'var(--accent)'
            }`,
            color: 'var(--text)',
            borderRadius: 'var(--radius)',
            padding: '10px 14px',
            marginBottom: '12px',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <span>
            {retriggerResult.remaining > 0 ? (
              <>
                Enqueued{' '}
                <b>{retriggerResult.created.toLocaleString()}</b>.{' '}
                <b>{retriggerResult.remaining.toLocaleString()}</b>{' '}
                remaining — click again to continue.
              </>
            ) : retriggerResult.created > 0 ? (
              <>
                Enqueued{' '}
                <b>{retriggerResult.created.toLocaleString()}</b>. All
                caught up — nothing left to re-resolve.
              </>
            ) : (
              <>All caught up — nothing flagged or unresolved.</>
            )}
          </span>
          <div style={{ display: 'flex', gap: '6px' }}>
            {retriggerResult.remaining > 0 && (
              <Button
                size="sm"
                variant="primary"
                loading={retriggerPending}
                disabled={retriggerPending}
                onClick={() => setPendingRetrigger(true)}
              >
                Re-resolve next batch
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRetriggerResult(null)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '12px',
          marginBottom: '12px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr)) auto',
          gap: '8px',
        }}
      >
        <input
          placeholder="Search name or address"
          value={filters.search}
          onChange={(e) => onFilterChange({ search: e.target.value })}
        />
        <input
          placeholder="City"
          value={filters.city}
          onChange={(e) => onFilterChange({ city: e.target.value })}
        />
        <input
          placeholder="State"
          value={filters.state}
          onChange={(e) => onFilterChange({ state: e.target.value })}
        />
        <Button
          variant="secondary"
          onClick={() => {
            setFilters(EMPTY_FILTERS);
            setPage(1);
            setSelectedIds(new Set());
            setSelectAllFiltered(false);
          }}
        >
          Reset
        </Button>
      </div>

      {/* select-all-filtered banner */}
      {rows.length > 0 &&
        rows.every((r) => selectedIds.has(r._id)) &&
        !selectAllFiltered &&
        total > rows.length && (
          <div
            style={{
              background: 'var(--accent-subtle)',
              border: '1px solid var(--accent)',
              color: 'var(--text)',
              borderRadius: 'var(--radius)',
              padding: '10px 14px',
              marginBottom: '12px',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>
              All {rows.length} on this page selected. Apply to all{' '}
              {total.toLocaleString()} filtered candidates?
            </span>
            <Button
              size="sm"
              variant="primary"
              onClick={() => setSelectAllFiltered(true)}
            >
              Select all filtered
            </Button>
          </div>
        )}
      {selectAllFiltered && (
        <div
          style={{
            background: 'var(--accent-subtle)',
            border: '1px solid var(--accent)',
            color: 'var(--text)',
            borderRadius: 'var(--radius)',
            padding: '10px 14px',
            marginBottom: '12px',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>
            Applying to all {total.toLocaleString()} filtered candidates.
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setSelectAllFiltered(false);
              setSelectedIds(new Set());
            }}
          >
            Clear selection
          </Button>
        </div>
      )}

      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr
              style={{
                borderBottom: '1px solid var(--border)',
                background: 'var(--surface-elevated)',
              }}
            >
              <th style={thStyle}>
                <input
                  type="checkbox"
                  disabled={rows.length === 0}
                  checked={
                    rows.length > 0 &&
                    rows.every((r) => selectedIds.has(r._id))
                  }
                  onChange={togglePageAll}
                />
              </th>
              {[
                'Name',
                'Address',
                'City / State',
                'Current placeId',
                'Hours',
                'Last resolve',
              ].map((h) => (
                <th key={h} style={thStyle}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {listQuery.isLoading && (
              <tr>
                <td colSpan={7} style={emptyCellStyle}>
                  Loading…
                </td>
              </tr>
            )}
            {listQuery.isError && (
              <tr>
                <td
                  colSpan={7}
                  style={{ ...emptyCellStyle, color: 'var(--red)' }}
                >
                  {(listQuery.error as Error).message}
                </td>
              </tr>
            )}
            {!listQuery.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={7} style={emptyCellStyle}>
                  No authentic candidates in {environment} match these
                  filters.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r._id}
                style={{
                  borderBottom: '1px solid var(--border)',
                  fontSize: '13px',
                }}
              >
                <td style={tdStyle}>
                  <input
                    type="checkbox"
                    checked={
                      selectAllFiltered || selectedIds.has(r._id)
                    }
                    disabled={selectAllFiltered}
                    onChange={() => togglePageRow(r._id)}
                  />
                </td>
                <td style={tdStyle}>
                  <div style={{ fontWeight: 500 }}>
                    {r.name || '(unnamed)'}
                  </div>
                  <div
                    style={{
                      fontSize: '11px',
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {r._id}
                  </div>
                </td>
                <td style={tdStyle}>
                  {r.addressLine1 || r.address1 || '—'}
                </td>
                <td style={tdStyle}>
                  {r.city || '—'}
                  {r.state ? `, ${r.state}` : ''}
                </td>
                <td
                  style={{
                    ...tdStyle,
                    fontFamily: 'var(--font-mono)',
                    fontSize: '11px',
                  }}
                >
                  {r.placeId ? (
                    <>
                      {r.placeId}
                      <a
                        href={`https://www.google.com/maps/place/?q=place_id:${r.placeId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          marginLeft: '4px',
                          color: 'var(--accent)',
                          textDecoration: 'none',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '2px',
                        }}
                      >
                        <ExternalLink size={11} />
                      </a>
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>—</span>
                  )}
                </td>
                <td style={tdStyle}>
                  {r.regularTimingIsPlaceholder && (
                    <Badge tone="amber">placeholder</Badge>
                  )}
                  {!r.regularTimingIsPlaceholder &&
                    r.hasRegularTiming && (
                      <Badge tone="green">custom</Badge>
                    )}
                  {!r.hasRegularTiming && (
                    <Badge tone="muted">none</Badge>
                  )}
                </td>
                <td style={tdStyle}>
                  <ResolveStatusBadge status={r.resolveStatus} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pages={pages}
        total={total}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(pages, p + 1))}
      />

      {pendingFix && (
        <FixCascadeConfirmModal
          variant="selected"
          environment={environment}
          count={pendingFix.count}
          confirming={triggerMutation.isPending}
          onCancel={() => setPendingFix(null)}
          onConfirm={() => triggerMutation.mutate()}
        />
      )}

      {pendingRetrigger && (
        <FixCascadeConfirmModal
          variant="retrigger"
          environment={environment}
          count={0}
          confirming={retriggerPending}
          onCancel={() => setPendingRetrigger(false)}
          onConfirm={() => retriggerMutation.mutate()}
        />
      )}

      {triggerMutation.isError && (
        <ErrorBanner message={(triggerMutation.error as Error).message} />
      )}
      {retriggerMutation.isError && (
        <ErrorBanner
          message={(retriggerMutation.error as Error).message}
        />
      )}
    </>
  );
}

// Confirms the one-click "Fix" cascade. Each selected business gets ONE
// bot visit (step 1 = resolve hours/rating/cover/category), then the
// API webhook auto-applies the mapped taxonomy (step 2) and runs the
// inline B2 cover upload (step 3) before responding. Already-fully-
// fixed businesses are skipped server-side, so re-clicking after a
// CAPTCHA-induced retry is safe.
//
// `variant` toggles between the per-selection path ("Fix selected"
// from the table) and the bulk re-run path ("Re-resolve flagged &
// unresolved"). Body copy + confirm label differ; the env-coloured
// banner + cancel chrome are shared.
const RETRIGGER_CAP = 1000;

function FixCascadeConfirmModal({
  variant = 'selected',
  environment,
  count,
  confirming,
  onCancel,
  onConfirm,
}: {
  variant?: 'selected' | 'retrigger';
  environment: Environment;
  count: number;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isProd = environment === 'production';
  const isRetrigger = variant === 'retrigger';
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 92vw)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            fontSize: '14px',
            fontWeight: 600,
            color: 'var(--text)',
          }}
        >
          {isRetrigger
            ? 'Re-resolve flagged & unresolved'
            : 'Confirm fix cascade'}
        </div>
        <div
          style={{
            padding: '18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            fontSize: '13px',
            color: 'var(--text)',
          }}
        >
          <div
            style={{
              padding: '10px 12px',
              background: isProd ? 'var(--red-subtle)' : 'var(--amber-subtle)',
              border: `1px solid ${isProd ? 'var(--red)' : 'var(--amber)'}`,
              borderRadius: 'var(--radius)',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '8px',
            }}
          >
            <AlertTriangle size={14} style={{ marginTop: '2px' }} />
            <div>
              {isRetrigger ? (
                <>
                  Re-runs the full cascade (resolve → taxonomy → cover)
                  on every business in <b> {environment}</b> that is
                  flagged for review OR has never been resolved (CVB
                  candidates with a placeId). Up to{' '}
                  {RETRIGGER_CAP.toLocaleString()} per click; satellites
                  and already-fully-fixed rows are excluded
                  server-side. Activation is NOT part of this cascade.
                </>
              ) : (
                <>
                  {count.toLocaleString()} businesses will be queued for
                  <b> {environment}</b>. Already-fully-fixed rows are
                  skipped server-side; activation is NOT part of this
                  cascade.
                </>
              )}
            </div>
          </div>
          <ol
            style={{
              paddingLeft: '20px',
              margin: 0,
              color: 'var(--text-secondary)',
              lineHeight: 1.6,
              fontSize: '12px',
            }}
          >
            <li>
              <b style={{ color: 'var(--text)' }}>Resolve</b> — one bot
              visit captures hours, rating, cover URL, googleCategory.
            </li>
            <li>
              <b style={{ color: 'var(--text)' }}>Auto-apply taxonomy</b> —
              mapped Google categories write businessIndustry +
              businessCategories. Unmapped stays flagged for operator.
            </li>
            <li>
              <b style={{ color: 'var(--text)' }}>Cover B2 sync</b> — if a
              cover URL was staged, the API downloads + uploads to B2
              inline, no second click needed.
            </li>
          </ol>
        </div>
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            background: 'var(--surface-elevated)',
          }}
        >
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={confirming}
            disabled={confirming || (!isRetrigger && count === 0)}
            onClick={onConfirm}
          >
            {confirming
              ? 'Enqueuing…'
              : isRetrigger
                ? `Re-resolve (up to ${RETRIGGER_CAP.toLocaleString()})`
                : `Enqueue ${count} fix jobs`}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Tab 2: Needs review ─────────────────────────────────────────────────

function ReviewTab({ environment }: { environment: Environment }) {
  const [page, setPage] = useState(1);
  const limit = 25;

  const listQuery = useQuery({
    queryKey: ['resolve-review', environment, page, limit],
    queryFn: async () => {
      const { data } = await apiClient.get<ReviewResponse>(
        '/seeding/resolve-business/review',
        { params: { environment, page, limit } },
      );
      return data;
    },
  });

  const rows = listQuery.data?.businesses ?? [];
  const total = listQuery.data?.total ?? 0;
  const pages = listQuery.data?.pages ?? 1;

  return (
    <>
      <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
        {total.toLocaleString()} business
        {total === 1 ? '' : 'es'} flagged. Confidence gate or hours
        parser rejected the bot result — review and fix manually.
      </div>

      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr
              style={{
                borderBottom: '1px solid var(--border)',
                background: 'var(--surface-elevated)',
              }}
            >
              {[
                'Stored name',
                'Resolved name (Google)',
                'Stored placeId',
                'Resolved placeId',
                'Reason',
                'Raw hours',
              ].map((h) => (
                <th key={h} style={thStyle}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {listQuery.isLoading && (
              <tr>
                <td colSpan={6} style={emptyCellStyle}>
                  Loading…
                </td>
              </tr>
            )}
            {listQuery.isError && (
              <tr>
                <td
                  colSpan={6}
                  style={{ ...emptyCellStyle, color: 'var(--red)' }}
                >
                  {(listQuery.error as Error).message}
                </td>
              </tr>
            )}
            {!listQuery.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6} style={emptyCellStyle}>
                  Nothing flagged in {environment}.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const reason = r.resolveStatus?.reason || '—';
              const hoursRaw = r.resolveStatus?.hoursRaw ?? [];
              return (
                <tr
                  key={r._id}
                  style={{
                    borderBottom: '1px solid var(--border)',
                    fontSize: '13px',
                  }}
                >
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 500 }}>
                      {r.name || '(unnamed)'}
                    </div>
                    <div
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-muted)',
                      }}
                    >
                      {r.city || '—'}
                      {r.state ? `, ${r.state}` : ''}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    {r.resolveStatus?.resolvedName || '—'}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      fontFamily: 'var(--font-mono)',
                      fontSize: '11px',
                    }}
                  >
                    {r.placeId || '—'}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      fontFamily: 'var(--font-mono)',
                      fontSize: '11px',
                    }}
                  >
                    {r.resolveStatus?.resolvedPlaceId || '—'}
                    {r.resolveStatus?.resolvedPlaceId && (
                      <a
                        href={`https://www.google.com/maps/place/?q=place_id:${r.resolveStatus.resolvedPlaceId}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          marginLeft: '4px',
                          color: 'var(--accent)',
                          textDecoration: 'none',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '2px',
                        }}
                      >
                        <ExternalLink size={11} />
                      </a>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <Badge tone="amber">{reason}</Badge>
                  </td>
                  <td style={tdStyle}>
                    {hoursRaw.length === 0 ? (
                      '—'
                    ) : (
                      <details style={{ fontSize: '11px' }}>
                        <summary
                          style={{
                            cursor: 'pointer',
                            color: 'var(--accent)',
                          }}
                        >
                          {hoursRaw.length} day
                          {hoursRaw.length === 1 ? '' : 's'}
                        </summary>
                        <code style={codeBlockStyle}>
                          {hoursRaw.join('\n')}
                        </code>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pages={pages}
        total={total}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(pages, p + 1))}
      />
    </>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────────

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '8px 14px',
        fontSize: '13px',
        fontWeight: active ? 600 : 500,
        background: 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        border: 'none',
        borderBottom: active
          ? '2px solid var(--accent)'
          : '2px solid transparent',
        cursor: 'pointer',
        marginBottom: '-1px',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: 'amber' | 'green' | 'muted' | 'red';
  children: React.ReactNode;
}) {
  const palette: Record<string, { bg: string; color: string }> = {
    amber: { bg: 'var(--amber-subtle)', color: 'var(--amber)' },
    green: { bg: 'var(--green-subtle)', color: 'var(--green)' },
    muted: {
      bg: 'var(--surface-elevated)',
      color: 'var(--text-muted)',
    },
    red: { bg: 'var(--red-subtle)', color: 'var(--red)' },
  };
  const p = palette[tone];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        fontWeight: 500,
        background: p.bg,
        color: p.color,
      }}
    >
      {children}
    </span>
  );
}

function ResolveStatusBadge({
  status,
}: {
  status?: ResolveCandidateRow['resolveStatus'];
}) {
  if (!status) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  if (status.status === 'done') {
    return <Badge tone="green">done</Badge>;
  }
  if (status.status === 'review') {
    return <Badge tone="red">review · {status.reason || '?'}</Badge>;
  }
  return <span style={{ color: 'var(--text-muted)' }}>—</span>;
}

function Pagination({
  page,
  pages,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  pages: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: '12px',
        fontSize: '12px',
        color: 'var(--text-secondary)',
      }}
    >
      <span>
        Page {page} of {pages} — {total.toLocaleString()} businesses
      </span>
      <div style={{ display: 'flex', gap: '6px' }}>
        <Button
          size="sm"
          variant="secondary"
          disabled={page <= 1}
          onClick={onPrev}
          icon={<ChevronLeft size={14} />}
        >
          Prev
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={page >= pages}
          onClick={onNext}
        >
          Next <ChevronRight size={14} />
        </Button>
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        marginTop: '12px',
        padding: '10px 14px',
        background: 'var(--red-subtle)',
        border: '1px solid var(--red)',
        borderRadius: 'var(--radius)',
        color: 'var(--red)',
        fontSize: '13px',
      }}
    >
      {message}
    </div>
  );
}

// ─── B2 cover sync banner ────────────────────────────────────────────────
//
// Standalone strip above the tabs. Renders the count of businesses whose
// resolve pass staged a pendingCoverUrl but whose final B2 upload hasn't
// happened yet. The actual Playwright-less download → B2 → write swap is
// done by the API's CoverB2SyncService; this UI only triggers it.

interface CoverB2SyncBannerProps {
  environment: Environment;
}

interface CoverB2PendingResponse {
  environment: string;
  count: number;
}

interface CoverB2RunResponse {
  synced: number;
  skipped: number;
  failed: number;
  total: number;
}

function CoverB2SyncBanner({ environment }: CoverB2SyncBannerProps) {
  const qc = useQueryClient();
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const pendingQuery = useQuery<CoverB2PendingResponse>({
    queryKey: ['cover-b2-sync', 'pending', environment],
    queryFn: async () => {
      const { data } = await apiClient.get<CoverB2PendingResponse>(
        '/seeding/cover-b2-sync/pending',
        { params: { environment } },
      );
      return data;
    },
    refetchInterval: 30000,
  });

  const runMutation = useMutation<
    CoverB2RunResponse,
    Error,
    { dryRun: boolean }
  >({
    mutationFn: async ({ dryRun }) => {
      const { data } = await apiClient.post<CoverB2RunResponse>(
        '/seeding/cover-b2-sync/run',
        { environment, limit: 50, dryRun },
      );
      return data;
    },
    onSuccess: (data, vars) => {
      setResultMsg(
        vars.dryRun
          ? `Dry-run: ${data.total} would be processed`
          : `Synced ${data.synced} · skipped ${data.skipped} · failed ${data.failed}`,
      );
      qc.invalidateQueries({
        queryKey: ['cover-b2-sync', 'pending', environment],
      });
    },
    onError: (err) => {
      setResultMsg(`Failed: ${err.message}`);
    },
  });

  const count = pendingQuery.data?.count ?? 0;
  // Hide the banner when nothing's pending and we're not mid-run. Keep
  // showing it while a result is fresh so the operator sees the outcome.
  if (count === 0 && !runMutation.isPending && !resultMsg) {
    return null;
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        background: 'var(--surface-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        marginBottom: '12px',
        fontSize: '13px',
        color: 'var(--text)',
        flexWrap: 'wrap',
      }}
    >
      <Sparkles size={14} style={{ color: 'var(--text-secondary)' }} />
      <span>
        <strong>{count}</strong>{' '}
        {count === 1 ? 'business has' : 'businesses have'} a pending Google
        cover awaiting B2 sync
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => runMutation.mutate({ dryRun: true })}
          disabled={runMutation.isPending || count === 0}
        >
          Dry run
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => runMutation.mutate({ dryRun: false })}
          disabled={runMutation.isPending || count === 0}
        >
          {runMutation.isPending ? 'Syncing…' : `Sync ${Math.min(count, 50)}`}
        </Button>
      </div>
      {resultMsg && (
        <div
          style={{
            flexBasis: '100%',
            fontSize: '12px',
            color: 'var(--text-secondary)',
          }}
        >
          {resultMsg}
        </div>
      )}
    </div>
  );
}

// ─── styles ─────────────────────────────────────────────────────────────

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-secondary)',
  fontWeight: 500,
  padding: '10px 14px',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 14px',
  color: 'var(--text)',
  verticalAlign: 'top',
};

const emptyCellStyle: React.CSSProperties = {
  padding: '40px',
  textAlign: 'center',
  color: 'var(--text-secondary)',
  fontSize: '13px',
};

const codeBlockStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  color: 'var(--text-muted)',
  background: 'var(--surface-elevated)',
  padding: '6px 8px',
  borderRadius: '4px',
  marginTop: '4px',
  whiteSpace: 'pre',
  maxHeight: '160px',
  overflow: 'auto',
};
