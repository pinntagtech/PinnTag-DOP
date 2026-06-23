import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { X, AlertTriangle, ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiClient } from '../lib/api-client';
import { Button } from '../components/ui/Button';

interface NotInProdRow {
  _id: string;
  name?: string;
  city?: string;
  state?: string;
  phone?: string;
  email?: string;
  website?: string;
  placeId?: string | null;
  logo?: string;
  cover?: string;
  industryName?: string | null;
  categoryNames?: string[];
}

interface NotInProdResponse {
  businesses: NotInProdRow[];
  total: number;
  page: number;
  pages: number;
}

interface DryRunResponse {
  dryRun: true;
  total: number;
  wouldMigrate: number;
  skippedAlreadyInProd: number;
  wouldMergeAsOutlet: number;
  wouldCreateStandalone: number;
  withMedia: number;
}

interface LiveRunResponse {
  dryRun: false;
  total: number;
  migrated: number;
  skippedAlreadyInProd: number;
  mergedAsOutlet: number;
  createdStandalone: number;
  mediaCopied: number;
  failed: number;
  errors: { businessId: string; name: string; error: string }[];
  migrationSessionId: string;
}

interface Filters {
  city: string;
  state: string;
  industry: string;
  category: string;
  search: string;
}

const EMPTY_FILTERS: Filters = {
  city: '',
  state: '',
  industry: '',
  category: '',
  search: '',
};

export default function StagingToProdPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const limit = 25;

  // Selection state. selectAllFiltered = "apply to the whole filtered
  // set, ignoring per-row checkboxes". selectedIds is per-row.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllFiltered, setSelectAllFiltered] = useState(false);

  // Migration modals
  const [dryRunResult, setDryRunResult] = useState<DryRunResponse | null>(
    null,
  );
  const [liveResult, setLiveResult] = useState<LiveRunResponse | null>(null);

  const queryFilters = useMemo(() => {
    const params: Record<string, string> = {};
    if (filters.city) params.city = filters.city;
    if (filters.state) params.state = filters.state;
    if (filters.industry) params.industry = filters.industry;
    if (filters.category) params.category = filters.category;
    if (filters.search) params.search = filters.search;
    params.page = String(page);
    params.limit = String(limit);
    return params;
  }, [filters, page]);

  const listQuery = useQuery({
    queryKey: ['cvb-migration-not-in-prod', queryFilters],
    queryFn: async () => {
      const { data } = await apiClient.get<NotInProdResponse>(
        '/seeding/cvb-migration/not-in-prod',
        { params: queryFilters },
      );
      return data;
    },
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
      if (allOnPageSelected) {
        const next = new Set(prev);
        rows.forEach((r) => next.delete(r._id));
        return next;
      }
      const next = new Set(prev);
      rows.forEach((r) => next.add(r._id));
      return next;
    });
  };

  const selectionCount = selectAllFiltered
    ? total
    : selectedIds.size;
  const canMigrate = selectionCount > 0;

  // Body sent to dry-run + live-run. When selectAllFiltered, send the
  // filter set; otherwise send the explicit ID list.
  const buildMigrateBody = (dryRun: boolean) => {
    if (selectAllFiltered) {
      return {
        filters: {
          city: filters.city || undefined,
          state: filters.state || undefined,
          industry: filters.industry || undefined,
          category: filters.category || undefined,
          search: filters.search || undefined,
        },
        dryRun,
      };
    }
    return {
      businessIds: [...selectedIds],
      dryRun,
    };
  };

  const dryRunMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<DryRunResponse>(
        '/seeding/cvb-migration/migrate',
        buildMigrateBody(true),
      );
      return data;
    },
    onSuccess: (data) => setDryRunResult(data),
  });

  const liveRunMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<LiveRunResponse>(
        '/seeding/cvb-migration/migrate',
        buildMigrateBody(false),
      );
      return data;
    },
    onSuccess: (data) => {
      setLiveResult(data);
      setDryRunResult(null);
      setSelectedIds(new Set());
      setSelectAllFiltered(false);
      listQuery.refetch();
    },
  });

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '20px',
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
            Staging → Prod
          </h1>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--text-secondary)',
              marginTop: '4px',
            }}
          >
            Migrate seeded CVB / crawler businesses from staging into
            production. {total.toLocaleString()} not in prod.
          </p>
        </div>
        <Button
          variant="primary"
          icon={<ArrowRight size={14} />}
          disabled={!canMigrate || dryRunMutation.isPending}
          loading={dryRunMutation.isPending}
          onClick={() => dryRunMutation.mutate()}
        >
          {dryRunMutation.isPending
            ? 'Computing dry-run…'
            : selectionCount > 0
              ? `Migrate to Production (${selectionCount})`
              : 'Migrate to Production'}
        </Button>
      </div>

      {/* Filters */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '12px',
          marginBottom: '16px',
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(160px, 1fr)) auto',
          gap: '8px',
        }}
      >
        <input
          placeholder="Search name/phone/email"
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
        <input
          placeholder="Industry ID"
          value={filters.industry}
          onChange={(e) => onFilterChange({ industry: e.target.value })}
        />
        <input
          placeholder="Category ID"
          value={filters.category}
          onChange={(e) => onFilterChange({ category: e.target.value })}
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

      {/* Select-all-filtered banner */}
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
              {total.toLocaleString()} filtered results?
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
            Applying to all {total.toLocaleString()} filtered results
            (server-side batched).
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

      {/* Table */}
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
                'City / State',
                'Industry',
                'Categories',
                'Place ID',
                'Website',
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
                <td
                  colSpan={7}
                  style={{
                    padding: '40px',
                    textAlign: 'center',
                    color: 'var(--text-secondary)',
                    fontSize: '13px',
                  }}
                >
                  Loading…
                </td>
              </tr>
            )}
            {listQuery.isError && (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    padding: '24px',
                    textAlign: 'center',
                    color: 'var(--red)',
                    fontSize: '13px',
                  }}
                >
                  {(listQuery.error as Error).message}
                </td>
              </tr>
            )}
            {!listQuery.isLoading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    padding: '40px',
                    textAlign: 'center',
                    color: 'var(--text-secondary)',
                    fontSize: '13px',
                  }}
                >
                  Nothing to migrate. All filtered staging businesses are
                  already in prod.
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
                  <div
                    style={{
                      fontWeight: 500,
                      color: 'var(--text)',
                    }}
                  >
                    {r.name || '(unnamed)'}
                  </div>
                  <div
                    style={{
                      fontSize: '11px',
                      color: 'var(--text-muted)',
                    }}
                  >
                    {r._id}
                  </div>
                </td>
                <td style={tdStyle}>
                  {r.city || '—'}
                  {r.state ? `, ${r.state}` : ''}
                </td>
                <td style={tdStyle}>{r.industryName || '—'}</td>
                <td style={tdStyle}>
                  {(r.categoryNames || []).join(', ') || '—'}
                </td>
                <td style={tdStyle}>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '11px',
                    }}
                  >
                    {r.placeId || '—'}
                  </span>
                </td>
                <td style={tdStyle}>
                  {r.website ? (
                    <a
                      href={r.website}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        color: 'var(--accent)',
                        textDecoration: 'none',
                      }}
                    >
                      {r.website.replace(/^https?:\/\//, '').slice(0, 32)}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
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
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            icon={<ChevronLeft size={14} />}
          >
            Prev
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={page >= pages}
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
          >
            Next <ChevronRight size={14} />
          </Button>
        </div>
      </div>

      {/* Dry-run confirm modal */}
      {dryRunResult && (
        <DryRunModal
          result={dryRunResult}
          confirming={liveRunMutation.isPending}
          onCancel={() => setDryRunResult(null)}
          onConfirm={() => liveRunMutation.mutate()}
        />
      )}

      {/* Live result modal */}
      {liveResult && (
        <LiveResultModal
          result={liveResult}
          onClose={() => setLiveResult(null)}
        />
      )}

      {(dryRunMutation.isError || liveRunMutation.isError) && (
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
          {(dryRunMutation.error || liveRunMutation.error)?.toString()}
        </div>
      )}
    </div>
  );
}

function DryRunModal({
  result,
  confirming,
  onCancel,
  onConfirm,
}: {
  result: DryRunResponse;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalShell title="Confirm migration to PRODUCTION" onClose={onCancel}>
      <div
        style={{
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            padding: '10px 12px',
            background: 'var(--amber-subtle)',
            border: '1px solid var(--amber)',
            borderRadius: 'var(--radius)',
            fontSize: '12px',
            color: 'var(--text)',
          }}
        >
          <AlertTriangle size={14} style={{ marginTop: '2px' }} />
          <div>
            This writes to <b>production</b>. Review the dry-run counts
            below before confirming.
          </div>
        </div>

        <StatRow label="Total considered" value={result.total} />
        <StatRow label="Would migrate" value={result.wouldMigrate} emphasis />
        <StatRow
          label="Already in prod (skipped)"
          value={result.skippedAlreadyInProd}
        />
        <StatRow
          label="Would merge as outlet (same brand, website match)"
          value={result.wouldMergeAsOutlet}
        />
        <StatRow
          label="Would create standalone"
          value={result.wouldCreateStandalone}
        />
        <StatRow label="With media" value={result.withMedia} />
      </div>
      <div
        style={{
          padding: '14px 24px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px',
        }}
      >
        <Button variant="secondary" onClick={onCancel} disabled={confirming}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={onConfirm}
          loading={confirming}
          disabled={confirming || result.wouldMigrate === 0}
        >
          {confirming ? 'Migrating…' : 'Confirm — migrate to PRODUCTION'}
        </Button>
      </div>
    </ModalShell>
  );
}

function LiveResultModal({
  result,
  onClose,
}: {
  result: LiveRunResponse;
  onClose: () => void;
}) {
  return (
    <ModalShell title="Migration complete" onClose={onClose}>
      <div
        style={{
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <StatRow label="Total" value={result.total} />
        <StatRow label="Migrated" value={result.migrated} emphasis />
        <StatRow label="Merged as outlet" value={result.mergedAsOutlet} />
        <StatRow label="Created standalone" value={result.createdStandalone} />
        <StatRow label="Media copied" value={result.mediaCopied} />
        <StatRow
          label="Skipped (already in prod)"
          value={result.skippedAlreadyInProd}
        />
        <StatRow label="Failed" value={result.failed} />

        {result.errors.length > 0 && (
          <div
            style={{
              marginTop: '12px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              maxHeight: '240px',
              overflowY: 'auto',
            }}
          >
            <div
              style={{
                padding: '8px 12px',
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-secondary)',
                background: 'var(--surface-elevated)',
                borderBottom: '1px solid var(--border)',
              }}
            >
              Errors ({result.errors.length})
            </div>
            {result.errors.map((e, i) => (
              <div
                key={`${e.businessId}-${i}`}
                style={{
                  padding: '8px 12px',
                  fontSize: '12px',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <div style={{ color: 'var(--text)' }}>{e.name}</div>
                <div
                  style={{
                    color: 'var(--text-muted)',
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {e.businessId}
                </div>
                <div
                  style={{
                    color: 'var(--red)',
                    marginTop: '2px',
                  }}
                >
                  {e.error}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div
        style={{
          padding: '14px 24px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'flex-end',
        }}
      >
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </ModalShell>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-xl)',
          width: '520px',
          maxHeight: '80vh',
          overflowY: 'auto',
          boxShadow: 'var(--shadow-lg)',
          color: 'var(--text)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 24px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <h2 style={{ fontSize: '14px', fontWeight: 600 }}>{title}</h2>
          <button
            onClick={onClose}
            style={{
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              padding: '4px',
              display: 'flex',
            }}
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: '13px',
      }}
    >
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span
        style={{
          color: emphasis ? 'var(--accent)' : 'var(--text)',
          fontWeight: emphasis ? 600 : 500,
        }}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}

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
