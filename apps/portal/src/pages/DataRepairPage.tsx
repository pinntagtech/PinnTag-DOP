import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  MapPinOff,
  Power,
  RefreshCw,
  Tag,
  Wrench,
  X,
} from 'lucide-react';
import type { Environment } from '@pinntag-dop/types';
import { apiClient } from '../lib/api-client';
import { Button } from '../components/ui/Button';

// ─── Types mirror the API responses ───────────────────────────────────────

interface BadTimingRow {
  _id: string;
  name?: string;
  city?: string;
  state?: string;
  regularTiming: unknown;
}

interface BadTimingListResponse {
  businesses: BadTimingRow[];
  total: number;
  page: number;
  pages: number;
}

interface RegularTimingFixResponse {
  dryRun: boolean;
  totalMatched: number;
  fixed: number;
  skipped: number;
  failed: number;
  errors: { id: string; name?: string; error: string }[];
}

interface MissingOutletRow {
  _id: string;
  name?: string;
  city?: string;
  state?: string;
  placeId?: string | null;
  addressLine1?: string;
  address1?: string;
}

interface MissingOutletListResponse {
  businesses: MissingOutletRow[];
  total: number;
  page: number;
  pages: number;
}

interface MissingOutletFixResponse {
  dryRun: boolean;
  totalSelected: number;
  fixed: number;
  created?: number;
  skipped: number;
  failed: number;
  errors: { id: string; name?: string; error: string }[];
  wouldCreate?: {
    businessId: string;
    name?: string;
    outlet: Record<string, any>;
  }[];
}

interface InactiveRow {
  _id: string;
  name?: string;
  addressLine1?: string;
  address1?: string;
  city?: string;
  state?: string;
  placeId?: string | null;
  isActive: boolean;
  outletActive: boolean;
  outletCount: number;
  hasHours: boolean;
  hasCover: boolean;
  rating: number | null;
  nameLooksReal: boolean;
}

interface InactiveListResponse {
  businesses: InactiveRow[];
  total: number;
  page: number;
  pages: number;
}

interface InactiveActivateResponse {
  dryRun: boolean;
  totalSelected: number;
  fixed: number;
  activated?: number;
  skipped: number;
  failed: number;
  errors: { id: string; name?: string; error: string }[];
  wouldFlip?: {
    businessId: string;
    name?: string;
    flipBusiness: boolean;
    flipOutletIds: string[];
  }[];
}

interface TaxonomyRow {
  _id: string;
  name?: string;
  placeId?: string | null;
  city?: string;
  state?: string;
  googleCategory?: string | null;
  categoryStatus: string;
  currentIndustryTitle?: string | null;
  currentCategoryTitles: string[];
  proposedIndustryTitle?: string | null;
  proposedCategoryTitles: string[];
  proposedIndustryId?: string | null;
  proposedCategoryIds: string[];
}

interface TaxonomyListResponse {
  businesses: TaxonomyRow[];
  total: number;
  page: number;
  pages: number;
}

interface TaxonomyApplyResponse {
  dryRun: boolean;
  totalSelected: number;
  fixed: number;
  applied?: number;
  skipped: number;
  failed: number;
  errors: { id: string; name?: string; error: string }[];
  wouldApply?: {
    businessId: string;
    name?: string;
    fromIndustry?: string | null;
    fromCategories: string[];
    toIndustry?: string | null;
    toCategories: string[];
  }[];
}

type TaxonomyStatusFilter = 'mismatch' | 'unmapped' | 'all';

type Tab =
  | 'regular-timing'
  | 'missing-outlet'
  | 'activate-inactive'
  | 'fix-taxonomy'
  | 'fix-address';

// ─── Address-parse types (mirror api/.../address-parse) ─────────────────

interface AddressComponents {
  address1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string | null;
  countryCode: string | null;
}

interface AddressMismatchRow {
  _id: string;
  name?: string;
  googleFormattedAddress?: string;
  current: AddressComponents;
  proposed: AddressComponents;
}

interface AddressMismatchListResponse {
  businesses: AddressMismatchRow[];
  total: number;
  page: number;
  pages: number;
}

interface AddressParseBatchResponse {
  environment: string;
  total: number;
  mismatch: number;
  correct: number;
  unparsed: number;
  parserUnreachable: number;
  failed: number;
  dryRun?: boolean;
}

interface AddressApplyResponse {
  total: number;
  applied: number;
  skipped: number;
  details: Array<{
    businessId: string;
    outcome: 'applied' | 'skipped';
    reason?: string;
  }>;
  dryRun?: boolean;
}

// ─── Address corruption (live-detection) types ──────────────────────────

type AddressCorruptSignature =
  | 'us_state_non_us_coords'
  | 'digits_only_city'
  | 'plus1_non_us_coords'
  | 'missing_country_with_addr';

interface AddressCorruptRow {
  _id: string;
  name: string;
  address1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  signatures: AddressCorruptSignature[];
  needsResolve: boolean;
  googleFormattedAddress: string | null;
  addressStatus: string | null;
}

interface AddressCorruptListResponse {
  businesses: AddressCorruptRow[];
  total: number;
  page: number;
  pages: number;
}

const CORRUPT_SIG_LABELS: Record<AddressCorruptSignature, string> = {
  us_state_non_us_coords: 'US state · non-US coords',
  digits_only_city: 'digits-only city',
  plus1_non_us_coords: '+1 · non-US coords',
  missing_country_with_addr: 'missing country',
};

// Cap per the brief: a single re-resolve click can enqueue at most 500.
// Mirrors the resolve trigger's own select-all caps; keeps a runaway
// click from saturating the bot queue.
const CORRUPT_RERESOLVE_CAP = 500;

const ENV_OPTIONS: { value: Environment; label: string }[] = [
  { value: 'production', label: 'Production' },
  { value: 'staging', label: 'Staging' },
  { value: 'pre-prod', label: 'Pre-prod' },
  { value: 'dev', label: 'Dev' },
];

export default function DataRepairPage() {
  // Target DB is selected on this page — independent from the
  // global env switcher in the header. The brief is explicit that
  // operators must pick the target DB here so they can't accidentally
  // run a repair against the wrong one because the header was sticky.
  const [targetEnv, setTargetEnv] = useState<Environment>('staging');
  const [tab, setTab] = useState<Tab>('regular-timing');

  return (
    <div>
      {/* Header */}
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
            Data Repair
          </h1>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--text-secondary)',
              marginTop: '4px',
            }}
          >
            Run deterministic fixes against the target database. Every
            action is preceded by a dry-run.
          </p>
        </div>

        {/* Target DB picker */}
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

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: '4px',
          borderBottom: '1px solid var(--border)',
          marginBottom: '16px',
        }}
      >
        <TabButton
          active={tab === 'regular-timing'}
          icon={<Clock size={14} />}
          label="Opening hours"
          onClick={() => setTab('regular-timing')}
        />
        <TabButton
          active={tab === 'missing-outlet'}
          icon={<MapPinOff size={14} />}
          label="Missing outlets"
          onClick={() => setTab('missing-outlet')}
        />
        <TabButton
          active={tab === 'activate-inactive'}
          icon={<Power size={14} />}
          label="Activate inactive"
          onClick={() => setTab('activate-inactive')}
        />
        <TabButton
          active={tab === 'fix-taxonomy'}
          icon={<Tag size={14} />}
          label="Fix taxonomy"
          onClick={() => setTab('fix-taxonomy')}
        />
        <TabButton
          active={tab === 'fix-address'}
          icon={<MapPin size={14} />}
          label="Fix address"
          onClick={() => setTab('fix-address')}
        />
      </div>

      {tab === 'regular-timing' && (
        <RegularTimingTab environment={targetEnv} />
      )}
      {tab === 'missing-outlet' && (
        <MissingOutletTab environment={targetEnv} />
      )}
      {tab === 'activate-inactive' && (
        <ActivateInactiveTab environment={targetEnv} />
      )}
      {tab === 'fix-taxonomy' && (
        <FixTaxonomyTab environment={targetEnv} />
      )}
      {tab === 'fix-address' && (
        <FixAddressTab environment={targetEnv} />
      )}
    </div>
  );
}

// ─── Tab 1: regularTiming ─────────────────────────────────────────────────

function RegularTimingTab({ environment }: { environment: Environment }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [applyAll, setApplyAll] = useState(false);

  const [pendingDryRun, setPendingDryRun] = useState<
    RegularTimingFixResponse | null
  >(null);
  const [liveResult, setLiveResult] = useState<RegularTimingFixResponse | null>(
    null,
  );

  const listKey = ['data-repair-regular-timing', environment, page, limit];
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const { data } = await apiClient.get<BadTimingListResponse>(
        '/data-repair/regular-timing',
        { params: { environment, page, limit } },
      );
      return data;
    },
  });

  const rows = listQuery.data?.businesses ?? [];
  const total = listQuery.data?.total ?? 0;
  const pages = listQuery.data?.pages ?? 1;

  const resetSelection = () => {
    setSelectedIds(new Set());
    setApplyAll(false);
  };

  const togglePageRow = (id: string) => {
    setApplyAll(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePageAll = () => {
    setApplyAll(false);
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

  const selectionCount = applyAll ? total : selectedIds.size;

  const buildBody = (dryRun: boolean, mode: 'selected' | 'all') => {
    if (mode === 'all') {
      return { environment, applyAll: true, dryRun };
    }
    return { environment, businessIds: [...selectedIds], dryRun };
  };

  const dryRunMutation = useMutation({
    mutationFn: async (mode: 'selected' | 'all') => {
      const { data } = await apiClient.post<RegularTimingFixResponse>(
        '/data-repair/regular-timing',
        buildBody(true, mode),
      );
      return { data, mode };
    },
    onSuccess: ({ data }) => setPendingDryRun(data),
  });

  const liveRunMutation = useMutation({
    mutationFn: async (mode: 'selected' | 'all') => {
      const { data } = await apiClient.post<RegularTimingFixResponse>(
        '/data-repair/regular-timing',
        buildBody(false, mode),
      );
      return data;
    },
    onSuccess: (data) => {
      setLiveResult(data);
      setPendingDryRun(null);
      resetSelection();
      qc.invalidateQueries({ queryKey: ['data-repair-regular-timing'] });
    },
  });

  // The mode (selected vs all) used when opening the dry-run modal —
  // re-used on confirm so live run hits the same scope.
  const [pendingMode, setPendingMode] = useState<'selected' | 'all' | null>(
    null,
  );

  const onDryRun = (mode: 'selected' | 'all') => {
    setPendingMode(mode);
    dryRunMutation.mutate(mode);
  };

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
          {total.toLocaleString()} businesses have a missing or non-object
          regularTiming.
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            variant="secondary"
            size="sm"
            icon={<Wrench size={13} />}
            disabled={
              selectionCount === 0 ||
              applyAll ||
              dryRunMutation.isPending ||
              liveRunMutation.isPending
            }
            loading={
              dryRunMutation.isPending && pendingMode === 'selected'
            }
            onClick={() => onDryRun('selected')}
          >
            Fix selected ({applyAll ? 0 : selectedIds.size})
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Wrench size={13} />}
            disabled={
              total === 0 ||
              dryRunMutation.isPending ||
              liveRunMutation.isPending
            }
            loading={dryRunMutation.isPending && pendingMode === 'all'}
            onClick={() => onDryRun('all')}
          >
            Fix all matching ({total.toLocaleString()})
          </Button>
        </div>
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
              {['Name', 'City / State', 'Current regularTiming', 'ID'].map(
                (h) => (
                  <th key={h} style={thStyle}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {listQuery.isLoading && (
              <tr>
                <td colSpan={5} style={emptyCellStyle}>
                  Loading…
                </td>
              </tr>
            )}
            {listQuery.isError && (
              <tr>
                <td colSpan={5} style={{ ...emptyCellStyle, color: 'var(--red)' }}>
                  {(listQuery.error as Error).message}
                </td>
              </tr>
            )}
            {!listQuery.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={5} style={emptyCellStyle}>
                  Nothing to fix in {environment}. Every business has a
                  valid regularTiming object.
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
                    checked={selectedIds.has(r._id)}
                    onChange={() => togglePageRow(r._id)}
                  />
                </td>
                <td style={tdStyle}>
                  <div style={{ fontWeight: 500 }}>{r.name || '(unnamed)'}</div>
                </td>
                <td style={tdStyle}>
                  {r.city || '—'}
                  {r.state ? `, ${r.state}` : ''}
                </td>
                <td style={tdStyle}>
                  <code style={codeStyle}>
                    {JSON.stringify(r.regularTiming ?? null)}
                  </code>
                </td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                  {r._id}
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

      {pendingDryRun && pendingMode && (
        <DryRunModal
          title="Confirm regularTiming repair"
          environment={environment}
          confirming={liveRunMutation.isPending}
          rows={[
            { label: 'Target DB', value: environment, mono: true },
            {
              label: 'Scope',
              value:
                pendingMode === 'all'
                  ? 'All matching businesses'
                  : `${pendingDryRun.totalMatched} selected`,
            },
            {
              label: 'Would fix',
              value: pendingDryRun.fixed.toLocaleString(),
              emphasis: true,
            },
          ]}
          onCancel={() => {
            setPendingDryRun(null);
            setPendingMode(null);
          }}
          onConfirm={() => liveRunMutation.mutate(pendingMode)}
        />
      )}

      {liveResult && (
        <ResultModal
          title="regularTiming repair complete"
          rows={[
            { label: 'Matched', value: liveResult.totalMatched.toLocaleString() },
            {
              label: 'Fixed',
              value: liveResult.fixed.toLocaleString(),
              emphasis: true,
            },
            { label: 'Skipped', value: liveResult.skipped.toLocaleString() },
            { label: 'Failed', value: liveResult.failed.toLocaleString() },
          ]}
          errors={liveResult.errors}
          onClose={() => setLiveResult(null)}
        />
      )}

      {(dryRunMutation.isError || liveRunMutation.isError) && (
        <ErrorBanner
          message={
            (dryRunMutation.error || liveRunMutation.error)?.toString() ?? ''
          }
        />
      )}
    </>
  );
}

// ─── Tab 2: missing outlets ───────────────────────────────────────────────

function MissingOutletTab({ environment }: { environment: Environment }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [pendingDryRun, setPendingDryRun] = useState<
    MissingOutletFixResponse | null
  >(null);
  const [liveResult, setLiveResult] = useState<MissingOutletFixResponse | null>(
    null,
  );

  const listKey = ['data-repair-missing-outlet', environment, page, limit];
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const { data } = await apiClient.get<MissingOutletListResponse>(
        '/data-repair/missing-outlet',
        { params: { environment, page, limit } },
      );
      return data;
    },
  });

  const rows = listQuery.data?.businesses ?? [];
  const total = listQuery.data?.total ?? 0;
  const pages = listQuery.data?.pages ?? 1;

  const selectionCount = selectedIds.size;

  const togglePageRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePageAll = () => {
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

  const dryRunMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<MissingOutletFixResponse>(
        '/data-repair/missing-outlet',
        {
          environment,
          businessIds: [...selectedIds],
          dryRun: true,
        },
      );
      return data;
    },
    onSuccess: (data) => setPendingDryRun(data),
  });

  const liveRunMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<MissingOutletFixResponse>(
        '/data-repair/missing-outlet',
        {
          environment,
          businessIds: [...selectedIds],
          dryRun: false,
        },
      );
      return data;
    },
    onSuccess: (data) => {
      setLiveResult(data);
      setPendingDryRun(null);
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ['data-repair-missing-outlet'] });
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
          {total.toLocaleString()} activated businesses are missing an
          outlet. Selection is required — review name + address before
          fixing so junk records can be excluded.
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<Wrench size={13} />}
          disabled={
            selectionCount === 0 ||
            dryRunMutation.isPending ||
            liveRunMutation.isPending
          }
          loading={dryRunMutation.isPending}
          onClick={() => dryRunMutation.mutate()}
        >
          Fix selected ({selectionCount})
        </Button>
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
              {['Name', 'Address', 'City / State', 'Place ID', 'ID'].map(
                (h) => (
                  <th key={h} style={thStyle}>
                    {h}
                  </th>
                ),
              )}
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
                <td colSpan={6} style={{ ...emptyCellStyle, color: 'var(--red)' }}>
                  {(listQuery.error as Error).message}
                </td>
              </tr>
            )}
            {!listQuery.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6} style={emptyCellStyle}>
                  Every business in {environment} has at least one outlet.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const address = r.addressLine1 || r.address1 || '—';
              return (
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
                      checked={selectedIds.has(r._id)}
                      onChange={() => togglePageRow(r._id)}
                    />
                  </td>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 500 }}>
                      {r.name || '(unnamed)'}
                    </div>
                  </td>
                  <td style={tdStyle}>{address}</td>
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
                    {r.placeId || '—'}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      fontFamily: 'var(--font-mono)',
                      fontSize: '11px',
                    }}
                  >
                    {r._id}
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

      {pendingDryRun && (
        <MissingOutletDryRunModal
          environment={environment}
          dryRun={pendingDryRun}
          confirming={liveRunMutation.isPending}
          onCancel={() => setPendingDryRun(null)}
          onConfirm={() => liveRunMutation.mutate()}
        />
      )}

      {liveResult && (
        <ResultModal
          title="Outlet repair complete"
          rows={[
            {
              label: 'Selected',
              value: liveResult.totalSelected.toLocaleString(),
            },
            {
              label: 'Created',
              value: (liveResult.created ?? liveResult.fixed).toLocaleString(),
              emphasis: true,
            },
            { label: 'Skipped', value: liveResult.skipped.toLocaleString() },
            { label: 'Failed', value: liveResult.failed.toLocaleString() },
          ]}
          errors={liveResult.errors}
          onClose={() => setLiveResult(null)}
        />
      )}

      {(dryRunMutation.isError || liveRunMutation.isError) && (
        <ErrorBanner
          message={
            (dryRunMutation.error || liveRunMutation.error)?.toString() ?? ''
          }
        />
      )}
    </>
  );
}

// ─── Tab 3: activate inactive ─────────────────────────────────────────────

function ActivateInactiveTab({ environment }: { environment: Environment }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [search, setSearch] = useState('');
  const [hideIncomplete, setHideIncomplete] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [pendingDryRun, setPendingDryRun] = useState<
    InactiveActivateResponse | null
  >(null);
  const [liveResult, setLiveResult] = useState<InactiveActivateResponse | null>(
    null,
  );

  // Reset page when filters change so we don't sit on an out-of-range
  // page that the API would return empty.
  const filterKey = `${city}|${state}|${search}|${hideIncomplete}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    if (page !== 1) setPage(1);
  }

  const listParams: Record<string, string> = {
    environment,
    page: String(page),
    limit: String(limit),
  };
  if (city) listParams.city = city;
  if (state) listParams.state = state;
  if (search) listParams.search = search;
  if (hideIncomplete) listParams.hideIncomplete = 'true';

  const listKey = [
    'data-repair-inactive',
    environment,
    page,
    limit,
    city,
    state,
    search,
    hideIncomplete,
  ];
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const { data } = await apiClient.get<InactiveListResponse>(
        '/data-repair/inactive',
        { params: listParams },
      );
      return data;
    },
  });

  const rows = listQuery.data?.businesses ?? [];
  const total = listQuery.data?.total ?? 0;
  const pages = listQuery.data?.pages ?? 1;
  const selectionCount = selectedIds.size;

  const togglePageRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePageAll = () => {
    setSelectedIds((prev) => {
      const allSelected = rows.every((r) => prev.has(r._id));
      const next = new Set(prev);
      if (allSelected) {
        rows.forEach((r) => next.delete(r._id));
      } else {
        rows.forEach((r) => next.add(r._id));
      }
      return next;
    });
  };

  // "Select all matching" — fetch a wide page of filtered IDs so the
  // operator can act on the whole filtered set in one go. Capped at
  // 1000 to keep the request small; if the filter matches more, they
  // need to narrow first (intentional — guards against blanket
  // 8.5k-row flips). Matches the backend listInactive page-size cap
  // and the activate-batch ceiling so all three are consistent.
  const SELECT_ALL_CAP = 1000;
  const selectAllFilteredMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.get<InactiveListResponse>(
        '/data-repair/inactive',
        {
          params: {
            ...listParams,
            page: '1',
            limit: String(SELECT_ALL_CAP),
          },
        },
      );
      return data;
    },
    onSuccess: (data) => {
      setSelectedIds(new Set(data.businesses.map((b) => b._id)));
    },
  });

  const dryRunMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<InactiveActivateResponse>(
        '/data-repair/inactive',
        {
          environment,
          businessIds: [...selectedIds],
          dryRun: true,
        },
      );
      return data;
    },
    onSuccess: (data) => setPendingDryRun(data),
  });

  const liveRunMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<InactiveActivateResponse>(
        '/data-repair/inactive',
        {
          environment,
          businessIds: [...selectedIds],
          dryRun: false,
        },
      );
      return data;
    },
    onSuccess: (data) => {
      setLiveResult(data);
      setPendingDryRun(null);
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ['data-repair-inactive'] });
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
          {total.toLocaleString()} standalone businesses are stuck inactive
          (satellites excluded). Selection is required — review the
          completeness columns before activating so junk doesn't go live.
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <Button
            variant="ghost"
            size="sm"
            disabled={
              total === 0 ||
              listQuery.isLoading ||
              selectAllFilteredMutation.isPending
            }
            loading={selectAllFilteredMutation.isPending}
            onClick={() => selectAllFilteredMutation.mutate()}
          >
            Select all matching ({Math.min(total, SELECT_ALL_CAP).toLocaleString()})
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Power size={13} />}
            disabled={
              selectionCount === 0 ||
              dryRunMutation.isPending ||
              liveRunMutation.isPending
            }
            loading={dryRunMutation.isPending}
            onClick={() => dryRunMutation.mutate()}
          >
            Activate selected ({selectionCount})
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '12px',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <input
          type="text"
          placeholder="Search name / address / placeId"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={inactiveInputStyle}
        />
        <input
          type="text"
          placeholder="City"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          style={{ ...inactiveInputStyle, maxWidth: '160px' }}
        />
        <input
          type="text"
          placeholder="State"
          value={state}
          onChange={(e) => setState(e.target.value)}
          style={{ ...inactiveInputStyle, maxWidth: '120px' }}
        />
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '13px',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={hideIncomplete}
            onChange={(e) => setHideIncomplete(e.target.checked)}
          />
          Hide incomplete (no hours / cover / real name)
        </label>
        {selectionCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection
          </Button>
        )}
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
                'Biz',
                'Outlet',
                'Hours',
                'Cover',
                'Rating',
                'Real name',
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
                <td colSpan={9} style={emptyCellStyle}>
                  Loading…
                </td>
              </tr>
            )}
            {listQuery.isError && (
              <tr>
                <td
                  colSpan={9}
                  style={{ ...emptyCellStyle, color: 'var(--red)' }}
                >
                  {(listQuery.error as Error).message}
                </td>
              </tr>
            )}
            {!listQuery.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={9} style={emptyCellStyle}>
                  No stuck-inactive standalone businesses match the current
                  filter.
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
                    checked={selectedIds.has(r._id)}
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
                    }}
                  >
                    {r.addressLine1 || r.address1 || '—'}
                  </div>
                </td>
                <td style={tdStyle}>
                  {r.city || '—'}
                  {r.state ? `, ${r.state}` : ''}
                </td>
                <td style={tdStyle}>
                  <ActiveBadge active={r.isActive} />
                </td>
                <td style={tdStyle}>
                  <ActiveBadge
                    active={r.outletActive}
                    label={
                      r.outletCount === 0
                        ? 'none'
                        : r.outletActive
                          ? 'on'
                          : 'off'
                    }
                  />
                </td>
                <td style={tdStyle}>
                  <CheckCell value={r.hasHours} />
                </td>
                <td style={tdStyle}>
                  <CheckCell value={r.hasCover} />
                </td>
                <td style={tdStyle}>
                  {r.rating != null ? r.rating.toFixed(1) : '—'}
                </td>
                <td style={tdStyle}>
                  <CheckCell value={r.nameLooksReal} />
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

      {pendingDryRun && (
        <InactiveDryRunModal
          environment={environment}
          dryRun={pendingDryRun}
          confirming={liveRunMutation.isPending}
          onCancel={() => setPendingDryRun(null)}
          onConfirm={() => liveRunMutation.mutate()}
        />
      )}

      {liveResult && (
        <ResultModal
          title="Activation complete"
          rows={[
            {
              label: 'Selected',
              value: liveResult.totalSelected.toLocaleString(),
            },
            {
              label: 'Activated',
              value: (liveResult.activated ?? liveResult.fixed).toLocaleString(),
              emphasis: true,
            },
            { label: 'Skipped', value: liveResult.skipped.toLocaleString() },
            { label: 'Failed', value: liveResult.failed.toLocaleString() },
          ]}
          errors={liveResult.errors}
          onClose={() => setLiveResult(null)}
        />
      )}

      {(dryRunMutation.isError ||
        liveRunMutation.isError ||
        selectAllFilteredMutation.isError) && (
        <ErrorBanner
          message={
            (
              dryRunMutation.error ||
              liveRunMutation.error ||
              selectAllFilteredMutation.error
            )?.toString() ?? ''
          }
        />
      )}
    </>
  );
}

function InactiveDryRunModal({
  environment,
  dryRun,
  confirming,
  onCancel,
  onConfirm,
}: {
  environment: Environment;
  dryRun: InactiveActivateResponse;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const wouldFlip = dryRun.wouldFlip ?? [];
  const flipBusinessCount = wouldFlip.filter((w) => w.flipBusiness).length;
  const flipOutletCount = wouldFlip.reduce(
    (sum, w) => sum + w.flipOutletIds.length,
    0,
  );
  const isProd = environment === 'production';
  return (
    <ModalShell
      title="Confirm activation"
      onClose={onCancel}
      width="640px"
    >
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
            background: isProd ? 'var(--red-subtle)' : 'var(--amber-subtle)',
            border: `1px solid ${isProd ? 'var(--red)' : 'var(--amber)'}`,
            borderRadius: 'var(--radius)',
            fontSize: '12px',
            color: 'var(--text)',
          }}
        >
          <AlertTriangle size={14} style={{ marginTop: '2px' }} />
          <div>
            This flips <b>{flipBusinessCount}</b> business.isActive and{' '}
            <b>{flipOutletCount}</b> outlet.isActive flags to true in{' '}
            <b>{environment}</b>. Satellites are excluded.
          </div>
        </div>
        <StatRow
          label="Selected"
          value={dryRun.totalSelected.toLocaleString()}
        />
        <StatRow
          label="Would activate"
          value={dryRun.fixed.toLocaleString()}
          emphasis
        />
        <StatRow
          label="Already active (skipped)"
          value={dryRun.skipped.toLocaleString()}
        />
        <StatRow label="Failed" value={dryRun.failed.toLocaleString()} />
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPreview((p) => !p)}
          >
            {showPreview ? 'Hide preview' : `Preview ${wouldFlip.length} flips`}
          </Button>
          {showPreview && (
            <code style={codeStyle}>
              {wouldFlip
                .slice(0, 100)
                .map(
                  (w) =>
                    `${w.businessId}  ${w.name ?? '(unnamed)'}  ` +
                    `biz=${w.flipBusiness ? 'flip' : 'ok'}  ` +
                    `outlets=${w.flipOutletIds.length}`,
                )
                .join('\n') || '(nothing to flip)'}
              {wouldFlip.length > 100
                ? `\n… and ${wouldFlip.length - 100} more`
                : ''}
            </code>
          )}
        </div>
      </div>
      <ModalFooter
        confirmLabel={
          confirming ? 'Activating…' : `Confirm — write to ${environment}`
        }
        confirmVariant="danger"
        confirming={confirming}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </ModalShell>
  );
}

function ActiveBadge({
  active,
  label,
}: {
  active: boolean;
  label?: string;
}) {
  const text = label ?? (active ? 'on' : 'off');
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        fontWeight: 500,
        background: active ? 'var(--green-subtle)' : 'var(--red-subtle)',
        color: active ? 'var(--green)' : 'var(--red)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {text}
    </span>
  );
}

function CheckCell({ value }: { value: boolean }) {
  return value ? (
    <Check size={14} style={{ color: 'var(--green)' }} />
  ) : (
    <X size={14} style={{ color: 'var(--red)' }} />
  );
}

const inactiveInputStyle: React.CSSProperties = {
  flex: '1 1 200px',
  minWidth: '160px',
  maxWidth: '300px',
  background: 'var(--surface)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: '6px 10px',
  fontSize: '13px',
  outline: 'none',
};

// ─── Tab 4: fix taxonomy ──────────────────────────────────────────────────

function FixTaxonomyTab({ environment }: { environment: Environment }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [statusFilter, setStatusFilter] =
    useState<TaxonomyStatusFilter>('mismatch');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [pendingDryRun, setPendingDryRun] = useState<
    TaxonomyApplyResponse | null
  >(null);
  const [liveResult, setLiveResult] = useState<TaxonomyApplyResponse | null>(
    null,
  );

  // Reset page when filter changes (otherwise we sit on an empty page
  // when the operator narrows the filter).
  const filterKey = `${statusFilter}|${city}|${state}|${search}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    if (page !== 1) setPage(1);
  }

  const listParams: Record<string, string> = {
    environment,
    page: String(page),
    limit: String(limit),
    statusFilter,
  };
  if (city) listParams.city = city;
  if (state) listParams.state = state;
  if (search) listParams.search = search;

  const listKey = [
    'data-repair-taxonomy',
    environment,
    page,
    limit,
    statusFilter,
    city,
    state,
    search,
  ];
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const { data } = await apiClient.get<TaxonomyListResponse>(
        '/data-repair/taxonomy',
        { params: listParams },
      );
      return data;
    },
  });

  const rows = listQuery.data?.businesses ?? [];
  const total = listQuery.data?.total ?? 0;
  const pages = listQuery.data?.pages ?? 1;
  const selectionCount = selectedIds.size;

  // Only mismatch rows are actionable. Selectability gating prevents an
  // operator from picking 'unmapped' rows and being surprised when they
  // skip — the apply path enforces the same guard server-side.
  const isActionable = (r: TaxonomyRow) =>
    r.categoryStatus === 'mismatch' &&
    !!r.proposedIndustryId &&
    r.proposedCategoryIds.length > 0;

  const togglePageRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePageAll = () => {
    const actionableRows = rows.filter(isActionable);
    setSelectedIds((prev) => {
      const allSelected =
        actionableRows.length > 0 &&
        actionableRows.every((r) => prev.has(r._id));
      const next = new Set(prev);
      if (allSelected) {
        actionableRows.forEach((r) => next.delete(r._id));
      } else {
        actionableRows.forEach((r) => next.add(r._id));
      }
      return next;
    });
  };

  const SELECT_ALL_CAP = 500;
  const selectAllFilteredMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.get<TaxonomyListResponse>(
        '/data-repair/taxonomy',
        {
          params: {
            ...listParams,
            page: '1',
            limit: String(SELECT_ALL_CAP),
          },
        },
      );
      return data;
    },
    onSuccess: (data) => {
      setSelectedIds(
        new Set(data.businesses.filter(isActionable).map((b) => b._id)),
      );
    },
  });

  const dryRunMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<TaxonomyApplyResponse>(
        '/data-repair/taxonomy',
        {
          environment,
          businessIds: [...selectedIds],
          dryRun: true,
        },
      );
      return data;
    },
    onSuccess: (data) => setPendingDryRun(data),
  });

  const liveRunMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<TaxonomyApplyResponse>(
        '/data-repair/taxonomy',
        {
          environment,
          businessIds: [...selectedIds],
          dryRun: false,
        },
      );
      return data;
    },
    onSuccess: (data) => {
      setLiveResult(data);
      setPendingDryRun(null);
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ['data-repair-taxonomy'] });
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
          {total.toLocaleString()} businesses flagged ({statusFilter}).
          Resolve writes proposed taxonomy when Google's category
          disagrees — selection here applies the proposal.
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <Button
            variant="ghost"
            size="sm"
            disabled={
              total === 0 ||
              listQuery.isLoading ||
              selectAllFilteredMutation.isPending
            }
            loading={selectAllFilteredMutation.isPending}
            onClick={() => selectAllFilteredMutation.mutate()}
          >
            Select all matching (
            {Math.min(total, SELECT_ALL_CAP).toLocaleString()})
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Tag size={13} />}
            disabled={
              selectionCount === 0 ||
              dryRunMutation.isPending ||
              liveRunMutation.isPending
            }
            loading={dryRunMutation.isPending}
            onClick={() => dryRunMutation.mutate()}
          >
            Apply taxonomy ({selectionCount})
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '12px',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '13px',
            color: 'var(--text-secondary)',
          }}
        >
          Status
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as TaxonomyStatusFilter)
            }
            style={{
              ...inactiveInputStyle,
              flex: '0 0 auto',
              maxWidth: '160px',
            }}
          >
            <option value="mismatch">Mismatch</option>
            <option value="unmapped">Unmapped</option>
            <option value="all">All flagged</option>
          </select>
        </label>
        <input
          type="text"
          placeholder="Search name / placeId / google category"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={inactiveInputStyle}
        />
        <input
          type="text"
          placeholder="City"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          style={{ ...inactiveInputStyle, maxWidth: '160px' }}
        />
        <input
          type="text"
          placeholder="State"
          value={state}
          onChange={(e) => setState(e.target.value)}
          style={{ ...inactiveInputStyle, maxWidth: '120px' }}
        />
        {selectionCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection
          </Button>
        )}
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
              <th style={thStyle}>
                <input
                  type="checkbox"
                  disabled={rows.length === 0}
                  checked={
                    rows.filter(isActionable).length > 0 &&
                    rows
                      .filter(isActionable)
                      .every((r) => selectedIds.has(r._id))
                  }
                  onChange={togglePageAll}
                />
              </th>
              {[
                'Name',
                'Google category',
                'Current → Proposed',
                'Status',
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
                <td colSpan={5} style={emptyCellStyle}>
                  Loading…
                </td>
              </tr>
            )}
            {listQuery.isError && (
              <tr>
                <td
                  colSpan={5}
                  style={{ ...emptyCellStyle, color: 'var(--red)' }}
                >
                  {(listQuery.error as Error).message}
                </td>
              </tr>
            )}
            {!listQuery.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={5} style={emptyCellStyle}>
                  No businesses match {statusFilter}.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const actionable = isActionable(r);
              return (
                <tr
                  key={r._id}
                  style={{
                    borderBottom: '1px solid var(--border)',
                    fontSize: '13px',
                    opacity: actionable ? 1 : 0.75,
                  }}
                >
                  <td style={tdStyle}>
                    <input
                      type="checkbox"
                      disabled={!actionable}
                      checked={selectedIds.has(r._id)}
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
                      }}
                    >
                      {(r.city || '—') +
                        (r.state ? `, ${r.state}` : '')}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    {r.googleCategory || (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <TaxonomyDiff row={r} />
                  </td>
                  <td style={tdStyle}>
                    <TaxonomyStatusBadge status={r.categoryStatus} />
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

      {pendingDryRun && (
        <TaxonomyDryRunModal
          environment={environment}
          dryRun={pendingDryRun}
          confirming={liveRunMutation.isPending}
          onCancel={() => setPendingDryRun(null)}
          onConfirm={() => liveRunMutation.mutate()}
        />
      )}

      {liveResult && (
        <ResultModal
          title="Taxonomy apply complete"
          rows={[
            {
              label: 'Selected',
              value: liveResult.totalSelected.toLocaleString(),
            },
            {
              label: 'Applied',
              value: (
                liveResult.applied ?? liveResult.fixed
              ).toLocaleString(),
              emphasis: true,
            },
            { label: 'Skipped', value: liveResult.skipped.toLocaleString() },
            { label: 'Failed', value: liveResult.failed.toLocaleString() },
          ]}
          errors={liveResult.errors}
          onClose={() => setLiveResult(null)}
        />
      )}

      {(dryRunMutation.isError ||
        liveRunMutation.isError ||
        selectAllFilteredMutation.isError) && (
        <ErrorBanner
          message={
            (
              dryRunMutation.error ||
              liveRunMutation.error ||
              selectAllFilteredMutation.error
            )?.toString() ?? ''
          }
        />
      )}
    </>
  );
}

function TaxonomyDiff({ row }: { row: TaxonomyRow }) {
  const currentParts = [
    row.currentIndustryTitle ?? '(no industry)',
    row.currentCategoryTitles.length
      ? row.currentCategoryTitles.join(', ')
      : '(no categories)',
  ].join(' · ');
  const proposedParts =
    row.proposedIndustryTitle || row.proposedCategoryTitles.length
      ? [
          row.proposedIndustryTitle ?? '(no industry)',
          row.proposedCategoryTitles.length
            ? row.proposedCategoryTitles.join(', ')
            : '(no categories)',
        ].join(' · ')
      : null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ color: 'var(--red)' }}>{currentParts}</span>
      {proposedParts ? (
        <>
          <ArrowRight size={12} style={{ color: 'var(--text-muted)' }} />
          <span style={{ color: 'var(--green)' }}>{proposedParts}</span>
        </>
      ) : (
        <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
          (no proposal)
        </span>
      )}
    </div>
  );
}

function TaxonomyStatusBadge({ status }: { status: string }) {
  const map: Record<
    string,
    { bg: string; color: string; label: string }
  > = {
    mismatch: {
      bg: 'var(--amber-subtle)',
      color: 'var(--amber)',
      label: 'mismatch',
    },
    unmapped: {
      bg: 'var(--red-subtle)',
      color: 'var(--red)',
      label: 'unmapped',
    },
    correct: {
      bg: 'var(--green-subtle)',
      color: 'var(--green)',
      label: 'correct',
    },
    no_google_cat: {
      bg: 'var(--surface-elevated)',
      color: 'var(--text-muted)',
      label: 'no google cat',
    },
  };
  const tone = map[status] ?? {
    bg: 'var(--surface-elevated)',
    color: 'var(--text-muted)',
    label: status,
  };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        fontWeight: 500,
        background: tone.bg,
        color: tone.color,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {tone.label}
    </span>
  );
}

function TaxonomyDryRunModal({
  environment,
  dryRun,
  confirming,
  onCancel,
  onConfirm,
}: {
  environment: Environment;
  dryRun: TaxonomyApplyResponse;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const wouldApply = dryRun.wouldApply ?? [];
  const isProd = environment === 'production';
  return (
    <ModalShell
      title="Confirm taxonomy apply"
      onClose={onCancel}
      width="640px"
    >
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
            background: isProd ? 'var(--red-subtle)' : 'var(--amber-subtle)',
            border: `1px solid ${isProd ? 'var(--red)' : 'var(--amber)'}`,
            borderRadius: 'var(--radius)',
            fontSize: '12px',
            color: 'var(--text)',
          }}
        >
          <AlertTriangle size={14} style={{ marginTop: '2px' }} />
          <div>
            Overwrites <b>{dryRun.fixed}</b> businesses'
            businessIndustry + businessCategories in <b>{environment}</b>{' '}
            with the resolve-proposed taxonomy. Non-mismatch rows are
            skipped.
          </div>
        </div>
        <StatRow
          label="Selected"
          value={dryRun.totalSelected.toLocaleString()}
        />
        <StatRow
          label="Would apply"
          value={dryRun.fixed.toLocaleString()}
          emphasis
        />
        <StatRow label="Skipped" value={dryRun.skipped.toLocaleString()} />
        <StatRow label="Failed" value={dryRun.failed.toLocaleString()} />
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPreview((p) => !p)}
          >
            {showPreview
              ? 'Hide preview'
              : `Preview ${wouldApply.length} changes`}
          </Button>
          {showPreview && (
            <code style={codeStyle}>
              {wouldApply
                .slice(0, 100)
                .map(
                  (w) =>
                    `${w.businessId}  ${w.name ?? '(unnamed)'}\n` +
                    `  from: ${w.fromIndustry ?? '—'}  ` +
                    `[${w.fromCategories.join(',') || '—'}]\n` +
                    `  to:   ${w.toIndustry ?? '—'}  ` +
                    `[${w.toCategories.join(',') || '—'}]`,
                )
                .join('\n') || '(nothing to apply)'}
              {wouldApply.length > 100
                ? `\n… and ${wouldApply.length - 100} more`
                : ''}
            </code>
          )}
        </div>
      </div>
      <ModalFooter
        confirmLabel={
          confirming ? 'Applying…' : `Confirm — write to ${environment}`
        }
        confirmVariant="danger"
        confirming={confirming}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </ModalShell>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────────

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

function DryRunModal({
  title,
  environment,
  rows,
  confirming,
  onCancel,
  onConfirm,
}: {
  title: string;
  environment: Environment;
  rows: { label: string; value: string | number; emphasis?: boolean; mono?: boolean }[];
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isProd = environment === 'production';
  return (
    <ModalShell title={title} onClose={onCancel}>
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
            background: isProd ? 'var(--red-subtle)' : 'var(--amber-subtle)',
            border: `1px solid ${isProd ? 'var(--red)' : 'var(--amber)'}`,
            borderRadius: 'var(--radius)',
            fontSize: '12px',
            color: 'var(--text)',
          }}
        >
          <AlertTriangle size={14} style={{ marginTop: '2px' }} />
          <div>
            This will write to <b>{environment}</b>. Review the dry-run
            counts below before confirming.
          </div>
        </div>
        {rows.map((r) => (
          <StatRow
            key={r.label}
            label={r.label}
            value={r.value}
            emphasis={r.emphasis}
            mono={r.mono}
          />
        ))}
      </div>
      <ModalFooter
        confirmLabel={confirming ? 'Applying…' : `Confirm — write to ${environment}`}
        confirmVariant="danger"
        confirming={confirming}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </ModalShell>
  );
}

function MissingOutletDryRunModal({
  environment,
  dryRun,
  confirming,
  onCancel,
  onConfirm,
}: {
  environment: Environment;
  dryRun: MissingOutletFixResponse;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const wouldCreate = dryRun.wouldCreate ?? [];
  const isProd = environment === 'production';
  return (
    <ModalShell
      title="Confirm missing-outlet repair"
      onClose={onCancel}
      width="640px"
    >
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
            background: isProd ? 'var(--red-subtle)' : 'var(--amber-subtle)',
            border: `1px solid ${isProd ? 'var(--red)' : 'var(--amber)'}`,
            borderRadius: 'var(--radius)',
            fontSize: '12px',
            color: 'var(--text)',
          }}
        >
          <AlertTriangle size={14} style={{ marginTop: '2px' }} />
          <div>
            Creates one PHYSICAL outlet per selected business in{' '}
            <b>{environment}</b>. Subscription and drive are left
            untouched — these businesses are already activated.
          </div>
        </div>
        <StatRow label="Target DB" value={environment} mono />
        <StatRow label="Selected" value={dryRun.totalSelected.toLocaleString()} />
        <StatRow
          label="Would create"
          value={dryRun.fixed.toLocaleString()}
          emphasis
        />
        <StatRow label="Skipped (already has outlet)" value={dryRun.skipped.toLocaleString()} />
        <StatRow label="Failed (missing coords / creator)" value={dryRun.failed.toLocaleString()} />

        {dryRun.errors.length > 0 && (
          <ErrorList errors={dryRun.errors} />
        )}

        {wouldCreate.length > 0 && (
          <div>
            <button
              onClick={() => setShowPreview((s) => !s)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--accent)',
                cursor: 'pointer',
                fontSize: '12px',
                padding: 0,
              }}
            >
              {showPreview ? 'Hide' : 'Show'} outlet preview ({wouldCreate.length})
            </button>
            {showPreview && (
              <div
                style={{
                  marginTop: '8px',
                  maxHeight: '240px',
                  overflowY: 'auto',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: '8px 12px',
                  background: 'var(--surface-elevated)',
                }}
              >
                {wouldCreate.slice(0, 25).map((w) => (
                  <div
                    key={w.businessId}
                    style={{
                      borderBottom: '1px solid var(--border)',
                      padding: '6px 0',
                      fontSize: '12px',
                    }}
                  >
                    <div style={{ fontWeight: 500 }}>
                      {w.name || '(unnamed)'}
                    </div>
                    <code style={codeStyle}>
                      {JSON.stringify({
                        name: w.outlet.name,
                        address1: w.outlet.address1,
                        city: w.outlet.city,
                        state: w.outlet.state,
                        zip: w.outlet.zip,
                        location: w.outlet.location,
                        category: w.outlet.category,
                      })}
                    </code>
                  </div>
                ))}
                {wouldCreate.length > 25 && (
                  <div
                    style={{
                      fontSize: '11px',
                      color: 'var(--text-muted)',
                      paddingTop: '6px',
                    }}
                  >
                    + {wouldCreate.length - 25} more
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <ModalFooter
        confirmLabel={confirming ? 'Creating outlets…' : `Confirm — create ${dryRun.fixed} outlets`}
        confirmVariant="danger"
        confirming={confirming || dryRun.fixed === 0}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </ModalShell>
  );
}

function ResultModal({
  title,
  rows,
  errors,
  onClose,
}: {
  title: string;
  rows: { label: string; value: string | number; emphasis?: boolean }[];
  errors: { id: string; name?: string; error: string }[];
  onClose: () => void;
}) {
  return (
    <ModalShell title={title} onClose={onClose}>
      <div
        style={{
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        {rows.map((r) => (
          <StatRow
            key={r.label}
            label={r.label}
            value={r.value}
            emphasis={r.emphasis}
          />
        ))}
        {errors.length > 0 && <ErrorList errors={errors} />}
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

function ErrorList({
  errors,
}: {
  errors: { id: string; name?: string; error: string }[];
}) {
  return (
    <div
      style={{
        marginTop: '6px',
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
        Errors ({errors.length})
      </div>
      {errors.map((e, i) => (
        <div
          key={`${e.id}-${i}`}
          style={{
            padding: '8px 12px',
            fontSize: '12px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div style={{ color: 'var(--text)' }}>{e.name || '(unnamed)'}</div>
          <div
            style={{
              color: 'var(--text-muted)',
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {e.id}
          </div>
          <div style={{ color: 'var(--red)', marginTop: '2px' }}>{e.error}</div>
        </div>
      ))}
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

function ModalShell({
  title,
  onClose,
  children,
  width = '520px',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
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
          width,
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

function ModalFooter({
  confirming,
  confirmLabel,
  confirmVariant,
  onCancel,
  onConfirm,
}: {
  confirming: boolean;
  confirmLabel: string;
  confirmVariant: 'primary' | 'danger';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
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
        variant={confirmVariant}
        onClick={onConfirm}
        loading={confirming}
        disabled={confirming}
      >
        {confirmLabel}
      </Button>
    </div>
  );
}

function StatRow({
  label,
  value,
  emphasis = false,
  mono = false,
}: {
  label: string;
  value: string | number;
  emphasis?: boolean;
  mono?: boolean;
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
          fontFamily: mono ? 'var(--font-mono)' : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Tab 5: Fix address ──────────────────────────────────────────────────
//
// Lists rows where the address-parse batch flagged a divergence between
// Google's authoritative single-line address and the stored components.
// Operator reviews side-by-side and clicks Apply to overwrite the
// stored fields with the proposed ones. The parser itself never
// auto-writes — this tab is the ONLY path that mutates address1 /
// city / state / postalCode / country / countryCode out-of-band of
// the operator's review.

function FixAddressTab({ environment }: { environment: Environment }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingDryRun, setPendingDryRun] =
    useState<AddressApplyResponse | null>(null);
  const [liveResult, setLiveResult] =
    useState<AddressApplyResponse | null>(null);
  const [parseResult, setParseResult] =
    useState<AddressParseBatchResponse | null>(null);

  // ── Corrupt-address detector state ─────────────────────────────
  // Independent pagination + selection state from the mismatch list
  // below so the operator can browse one while keeping a selection
  // in the other.
  const [corruptPage, setCorruptPage] = useState(1);
  const corruptLimit = 25;
  const [corruptSig, setCorruptSig] =
    useState<AddressCorruptSignature | 'all'>('all');
  const [corruptCity, setCorruptCity] = useState('');
  const [corruptState, setCorruptState] = useState('');
  const [corruptSelected, setCorruptSelected] = useState<Set<string>>(
    new Set(),
  );
  const [reresolveResult, setReresolveResult] = useState<{
    created: number;
    skipped: number;
  } | null>(null);

  // Pending-parse count: drives the "Run parser" banner so the
  // operator can see how many raw-captured rows haven't been processed
  // by libpostal yet. Refreshes after a successful run mutation.
  const pendingQuery = useQuery({
    queryKey: ['address-parse-pending', environment],
    queryFn: async () => {
      const { data } = await apiClient.get<{
        environment: string;
        count: number;
      }>('/seeding/address-parse/pending', { params: { environment } });
      return data;
    },
  });

  const listQuery = useQuery({
    queryKey: ['address-mismatch', environment, page, limit],
    queryFn: async () => {
      const { data } = await apiClient.get<AddressMismatchListResponse>(
        '/seeding/address-parse/mismatch',
        { params: { environment, page, limit } },
      );
      return data;
    },
  });

  const rows = listQuery.data?.businesses ?? [];
  const total = listQuery.data?.total ?? 0;
  const pages = listQuery.data?.pages ?? 1;
  const selectionCount = selectedIds.size;

  // Selectability: only rows with a non-empty proposed.address1 OR
  // proposed.city are actionable. The apply path enforces the same
  // guard server-side so this is purely UX.
  const isActionable = (r: AddressMismatchRow) =>
    !!(
      r.proposed.address1 ||
      r.proposed.city ||
      r.proposed.state ||
      r.proposed.postalCode
    );

  const togglePageRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePageAll = () => {
    const actionableRows = rows.filter(isActionable);
    setSelectedIds((prev) => {
      const allSelected =
        actionableRows.length > 0 &&
        actionableRows.every((r) => prev.has(r._id));
      const next = new Set(prev);
      if (allSelected) {
        actionableRows.forEach((r) => next.delete(r._id));
      } else {
        actionableRows.forEach((r) => next.add(r._id));
      }
      return next;
    });
  };

  const parseRunMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<AddressParseBatchResponse>(
        '/seeding/address-parse/run',
        { environment, limit: 50 },
      );
      return data;
    },
    onSuccess: (data) => {
      setParseResult(data);
      qc.invalidateQueries({ queryKey: ['address-parse-pending'] });
      qc.invalidateQueries({ queryKey: ['address-mismatch'] });
    },
  });

  const dryRunMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<AddressApplyResponse>(
        '/seeding/address-parse/apply',
        {
          environment,
          businessIds: [...selectedIds],
          dryRun: true,
        },
      );
      return data;
    },
    onSuccess: (data) => setPendingDryRun(data),
  });

  const liveRunMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<AddressApplyResponse>(
        '/seeding/address-parse/apply',
        {
          environment,
          businessIds: [...selectedIds],
          dryRun: false,
        },
      );
      return data;
    },
    onSuccess: (data) => {
      setLiveResult(data);
      setPendingDryRun(null);
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ['address-mismatch'] });
      qc.invalidateQueries({ queryKey: ['address-parse-pending'] });
    },
  });

  // Reset corrupt page when filters change — otherwise we sit on an
  // empty page after narrowing.
  const corruptFilterKey = `${corruptSig}|${corruptCity}|${corruptState}`;
  const [lastCorruptFilterKey, setLastCorruptFilterKey] =
    useState(corruptFilterKey);
  if (lastCorruptFilterKey !== corruptFilterKey) {
    setLastCorruptFilterKey(corruptFilterKey);
    if (corruptPage !== 1) setCorruptPage(1);
  }

  const corruptParams: Record<string, string> = {
    environment,
    page: String(corruptPage),
    limit: String(corruptLimit),
  };
  if (corruptSig !== 'all') corruptParams.signature = corruptSig;
  if (corruptCity) corruptParams.city = corruptCity;
  if (corruptState) corruptParams.state = corruptState;

  const corruptQuery = useQuery({
    queryKey: [
      'address-corrupt',
      environment,
      corruptPage,
      corruptLimit,
      corruptSig,
      corruptCity,
      corruptState,
    ],
    queryFn: async () => {
      const { data } = await apiClient.get<AddressCorruptListResponse>(
        '/data-repair/address-corrupt',
        { params: corruptParams },
      );
      return data;
    },
  });

  const corruptRows = corruptQuery.data?.businesses ?? [];
  const corruptTotal = corruptQuery.data?.total ?? 0;
  const corruptPages = corruptQuery.data?.pages ?? 1;

  const toggleCorruptRow = (id: string) => {
    setCorruptSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < CORRUPT_RERESOLVE_CAP) next.add(id);
      return next;
    });
  };

  const toggleCorruptPageAll = () => {
    setCorruptSelected((prev) => {
      const allOnPage =
        corruptRows.length > 0 &&
        corruptRows.every((r) => prev.has(r._id));
      const next = new Set(prev);
      if (allOnPage) {
        corruptRows.forEach((r) => next.delete(r._id));
      } else {
        for (const r of corruptRows) {
          if (next.size >= CORRUPT_RERESOLVE_CAP) break;
          next.add(r._id);
        }
      }
      return next;
    });
  };

  // Re-resolve uses the EXISTING resolve trigger endpoint — no new
  // server-side path. Cap is enforced client-side by the selection-set
  // size guard above; the bulk-resolve cap on the API is 1000, this
  // tab's cap (500) is intentionally lower.
  const reresolveMutation = useMutation({
    mutationFn: async () => {
      const businessIds = [...corruptSelected].slice(
        0,
        CORRUPT_RERESOLVE_CAP,
      );
      const { data } = await apiClient.post<{
        created: number;
        skippedAlreadyDone: number;
      }>('/seeding/resolve-business/trigger', {
        environment,
        businessIds,
      });
      return data;
    },
    onSuccess: (data) => {
      setReresolveResult({
        created: data.created,
        skipped: data.skippedAlreadyDone,
      });
      setCorruptSelected(new Set());
      qc.invalidateQueries({ queryKey: ['address-corrupt'] });
      qc.invalidateQueries({ queryKey: ['address-parse-pending'] });
    },
  });

  return (
    <>
      {/* ── Corrupt-address detector (ABOVE the parse pipeline) ─────── */}
      <CorruptAddressSection
        environment={environment}
        rows={corruptRows}
        total={corruptTotal}
        page={corruptPage}
        pages={corruptPages}
        signature={corruptSig}
        city={corruptCity}
        state={corruptState}
        selected={corruptSelected}
        loading={corruptQuery.isLoading}
        error={
          corruptQuery.isError
            ? (corruptQuery.error as Error).message
            : null
        }
        onSignatureChange={setCorruptSig}
        onCityChange={setCorruptCity}
        onStateChange={setCorruptState}
        onResetFilters={() => {
          setCorruptSig('all');
          setCorruptCity('');
          setCorruptState('');
        }}
        onToggleRow={toggleCorruptRow}
        onTogglePageAll={toggleCorruptPageAll}
        onPrev={() =>
          setCorruptPage((p) => Math.max(1, p - 1))
        }
        onNext={() =>
          setCorruptPage((p) => Math.min(corruptPages, p + 1))
        }
        reresolving={reresolveMutation.isPending}
        onReresolve={() => reresolveMutation.mutate()}
        reresolveResult={reresolveResult}
        onDismissResult={() => setReresolveResult(null)}
      />

      {/* Parse-pending banner */}
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
          {pendingQuery.data?.count?.toLocaleString() ?? '…'} business
          {pendingQuery.data?.count === 1 ? '' : 'es'} with a captured
          raw address awaiting libpostal parse.{' '}
          {total.toLocaleString()} flagged as mismatch below.
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw size={13} />}
          loading={parseRunMutation.isPending}
          disabled={parseRunMutation.isPending}
          onClick={() => parseRunMutation.mutate()}
        >
          Run parser (50)
        </Button>
      </div>

      {parseResult && (
        <div
          style={{
            background:
              parseResult.parserUnreachable > 0
                ? 'var(--amber-subtle)'
                : 'var(--accent-subtle)',
            border: `1px solid ${
              parseResult.parserUnreachable > 0
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
            Parsed {parseResult.total.toLocaleString()} —{' '}
            mismatch <b>{parseResult.mismatch.toLocaleString()}</b>,{' '}
            correct <b>{parseResult.correct.toLocaleString()}</b>,{' '}
            unparsed <b>{parseResult.unparsed.toLocaleString()}</b>
            {parseResult.parserUnreachable > 0 && (
              <>
                , <b>parser unreachable {parseResult.parserUnreachable}</b>
              </>
            )}
            {parseResult.failed > 0 && (
              <>
                , <b>failed {parseResult.failed}</b>
              </>
            )}
            .
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setParseResult(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {liveResult && (
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
            gap: '12px',
          }}
        >
          <span>
            Applied <b>{liveResult.applied.toLocaleString()}</b>,{' '}
            skipped <b>{liveResult.skipped.toLocaleString()}</b> of{' '}
            {liveResult.total.toLocaleString()}.
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setLiveResult(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

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
          {selectionCount.toLocaleString()} selected. Apply writes
          address1/city/state/postalCode/country/countryCode from the
          proposed column and clears the mismatch flag.
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <Button
            variant="ghost"
            size="sm"
            icon={<Check size={13} />}
            disabled={
              selectionCount === 0 ||
              dryRunMutation.isPending ||
              liveRunMutation.isPending
            }
            loading={dryRunMutation.isPending}
            onClick={() => dryRunMutation.mutate()}
          >
            Dry run ({selectionCount})
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<ArrowRight size={13} />}
            disabled={
              !pendingDryRun ||
              liveRunMutation.isPending ||
              selectionCount === 0
            }
            loading={liveRunMutation.isPending}
            onClick={() => liveRunMutation.mutate()}
          >
            Apply ({pendingDryRun?.applied ?? 0})
          </Button>
        </div>
      </div>

      {pendingDryRun && (
        <div
          style={{
            background: 'var(--surface-elevated)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            borderRadius: 'var(--radius)',
            padding: '10px 14px',
            marginBottom: '12px',
            fontSize: '13px',
          }}
        >
          Dry run: would apply{' '}
          <b>{pendingDryRun.applied.toLocaleString()}</b>, skip{' '}
          <b>{pendingDryRun.skipped.toLocaleString()}</b> of{' '}
          {pendingDryRun.total.toLocaleString()}. Review then click
          Apply.
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
                    rows
                      .filter(isActionable)
                      .every((r) => selectedIds.has(r._id))
                  }
                  onChange={togglePageAll}
                />
              </th>
              {['Business', 'Current', 'Proposed (Google)', 'Raw'].map(
                (h) => (
                  <th key={h} style={thStyle}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {listQuery.isLoading && (
              <tr>
                <td colSpan={5} style={emptyCellStyle}>
                  Loading…
                </td>
              </tr>
            )}
            {listQuery.isError && (
              <tr>
                <td
                  colSpan={5}
                  style={{ ...emptyCellStyle, color: 'var(--red)' }}
                >
                  {(listQuery.error as Error).message}
                </td>
              </tr>
            )}
            {!listQuery.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={5} style={emptyCellStyle}>
                  Nothing flagged as address_mismatch in {environment}.
                  Run the parser above if there are pending rows, or
                  resolve more businesses to capture addresses first.
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
                    checked={selectedIds.has(r._id)}
                    disabled={!isActionable(r)}
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
                  <AddressBlock components={r.current} />
                </td>
                <td style={tdStyle}>
                  <AddressBlock
                    components={r.proposed}
                    highlight
                    current={r.current}
                  />
                </td>
                <td style={tdStyle}>
                  <code style={codeStyle}>
                    {r.googleFormattedAddress || '—'}
                  </code>
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
    </>
  );
}

// Corrupt-address scanner UI. Lives above the parse-pipeline list so
// operators can find businesses whose live address fields disagree
// with their coordinates / country / phone country code WITHOUT
// having to wait on a googleFormattedAddress capture. Selected rows
// can be re-resolved (cap 500) via the existing resolve trigger; the
// captured googleFormattedAddress then flows into the parse → mismatch
// → apply pipeline on the rest of the page.
function CorruptAddressSection(props: {
  environment: Environment;
  rows: AddressCorruptRow[];
  total: number;
  page: number;
  pages: number;
  signature: AddressCorruptSignature | 'all';
  city: string;
  state: string;
  selected: Set<string>;
  loading: boolean;
  error: string | null;
  onSignatureChange: (
    v: AddressCorruptSignature | 'all',
  ) => void;
  onCityChange: (v: string) => void;
  onStateChange: (v: string) => void;
  onResetFilters: () => void;
  onToggleRow: (id: string) => void;
  onTogglePageAll: () => void;
  onPrev: () => void;
  onNext: () => void;
  reresolving: boolean;
  onReresolve: () => void;
  reresolveResult: { created: number; skipped: number } | null;
  onDismissResult: () => void;
}) {
  const {
    rows, total, page, pages, signature, city, state, selected,
    loading, error,
  } = props;
  const selectionCount = selected.size;
  const allOnPageSelected =
    rows.length > 0 && rows.every((r) => selected.has(r._id));
  const capReached = selectionCount >= CORRUPT_RERESOLVE_CAP;

  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--surface)',
        padding: '12px',
        marginBottom: '16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          flexWrap: 'wrap',
          marginBottom: '10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={14} style={{ color: 'var(--amber)' }} />
          <span style={{ fontSize: '13px', fontWeight: 600 }}>
            Corrupt addresses ({total.toLocaleString()})
          </span>
          <span
            style={{ fontSize: '12px', color: 'var(--text-secondary)' }}
          >
            — stored fields contradict coordinates / phone / country.
            Re-resolve to capture Google's address, then parse.
          </span>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {selectionCount} / {CORRUPT_RERESOLVE_CAP} selected
          </span>
          <Button
            variant="primary"
            size="sm"
            icon={<RefreshCw size={13} />}
            disabled={selectionCount === 0 || props.reresolving}
            loading={props.reresolving}
            onClick={props.onReresolve}
          >
            Re-resolve selected (cap {CORRUPT_RERESOLVE_CAP})
          </Button>
        </div>
      </div>

      {/* filters */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'minmax(180px, 1fr) minmax(120px, 1fr) minmax(120px, 1fr) auto',
          gap: '8px',
          marginBottom: '10px',
        }}
      >
        <select
          value={signature}
          onChange={(e) =>
            props.onSignatureChange(
              e.target.value as AddressCorruptSignature | 'all',
            )
          }
          style={{
            background: 'var(--surface-elevated)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '6px 10px',
            fontSize: '13px',
          }}
        >
          <option value="all">All signatures</option>
          <option value="us_state_non_us_coords">
            {CORRUPT_SIG_LABELS.us_state_non_us_coords}
          </option>
          <option value="digits_only_city">
            {CORRUPT_SIG_LABELS.digits_only_city}
          </option>
          <option value="plus1_non_us_coords">
            {CORRUPT_SIG_LABELS.plus1_non_us_coords}
          </option>
          <option value="missing_country_with_addr">
            {CORRUPT_SIG_LABELS.missing_country_with_addr}
          </option>
        </select>
        <input
          placeholder="City"
          value={city}
          onChange={(e) => props.onCityChange(e.target.value)}
        />
        <input
          placeholder="State"
          value={state}
          onChange={(e) => props.onStateChange(e.target.value)}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={props.onResetFilters}
        >
          Reset
        </Button>
      </div>

      {props.reresolveResult && (
        <div
          style={{
            background: 'var(--accent-subtle)',
            border: '1px solid var(--accent)',
            color: 'var(--text)',
            borderRadius: 'var(--radius)',
            padding: '8px 12px',
            marginBottom: '10px',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <span>
            Enqueued{' '}
            <b>{props.reresolveResult.created.toLocaleString()}</b>{' '}
            re-resolves
            {props.reresolveResult.skipped > 0 && (
              <>
                ,{' '}
                <b>{props.reresolveResult.skipped.toLocaleString()}</b>{' '}
                skipped (already fully fixed)
              </>
            )}
            . After resolve completes, the Run parser button below
            will turn the new addresses into mismatch proposals.
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={props.onDismissResult}
          >
            Dismiss
          </Button>
        </div>
      )}

      {capReached && (
        <div
          style={{
            fontSize: '12px',
            color: 'var(--amber)',
            marginBottom: '8px',
          }}
        >
          Selection cap reached ({CORRUPT_RERESOLVE_CAP}). Re-resolve
          this batch, then come back for the next one.
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
                  checked={allOnPageSelected}
                  onChange={props.onTogglePageAll}
                />
              </th>
              {[
                'Business',
                'Stored address',
                'Coords',
                'Signatures',
                'Status',
              ].map((h) => (
                <th key={h} style={thStyle}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} style={emptyCellStyle}>
                  Loading…
                </td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td
                  colSpan={6}
                  style={{ ...emptyCellStyle, color: 'var(--red)' }}
                >
                  {error}
                </td>
              </tr>
            )}
            {!loading && !error && rows.length === 0 && (
              <tr>
                <td colSpan={6} style={emptyCellStyle}>
                  No corrupt addresses in {props.environment} match
                  these filters.
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
                    checked={selected.has(r._id)}
                    onChange={() => props.onToggleRow(r._id)}
                    disabled={
                      !selected.has(r._id) && capReached
                    }
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
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '2px',
                      fontSize: '12px',
                      color: 'var(--text)',
                    }}
                  >
                    <span>{r.address1 || '—'}</span>
                    <CorruptAddressFieldRow
                      label="city"
                      value={r.city}
                      bad={r.signatures.includes('digits_only_city')}
                    />
                    <CorruptAddressFieldRow
                      label="state"
                      value={r.state}
                      bad={r.signatures.includes(
                        'us_state_non_us_coords',
                      )}
                    />
                    <CorruptAddressFieldRow
                      label="postal"
                      value={r.postalCode}
                    />
                    <CorruptAddressFieldRow
                      label="country"
                      value={r.country}
                      bad={r.signatures.includes(
                        'missing_country_with_addr',
                      )}
                    />
                    <CorruptAddressFieldRow
                      label="cc"
                      value={r.countryCode}
                      bad={r.signatures.includes(
                        'plus1_non_us_coords',
                      )}
                    />
                  </div>
                </td>
                <td style={tdStyle}>
                  {typeof r.latitude === 'number' &&
                  typeof r.longitude === 'number' ? (
                    <code style={codeStyle}>
                      {r.latitude.toFixed(4)},{' '}
                      {r.longitude.toFixed(4)}
                    </code>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>
                      —
                    </span>
                  )}
                </td>
                <td style={tdStyle}>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '3px',
                    }}
                  >
                    {r.signatures.map((s) => (
                      <CorruptSigBadge key={s} signature={s} />
                    ))}
                  </div>
                </td>
                <td style={tdStyle}>
                  <ReadyStateBadge needsResolve={r.needsResolve} />
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
        onPrev={props.onPrev}
        onNext={props.onNext}
      />
    </section>
  );
}

// One-row labeled field inside the corrupt-address "Stored address"
// column. `bad=true` paints it red so the operator's eye lands on
// the specific field the signature is complaining about.
function CorruptAddressFieldRow({
  label,
  value,
  bad,
}: {
  label: string;
  value: string;
  bad?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: '6px',
        fontSize: '12px',
        color: bad ? 'var(--red)' : 'var(--text-muted)',
        fontWeight: bad ? 600 : 400,
      }}
    >
      <span style={{ minWidth: '54px', textTransform: 'uppercase' }}>
        {label}
      </span>
      <span style={{ wordBreak: 'break-word' }}>{value || '—'}</span>
    </div>
  );
}

function CorruptSigBadge({
  signature,
}: {
  signature: AddressCorruptSignature;
}) {
  // Strong contradictions (US-state-vs-coords, +1-vs-coords) get red;
  // softer hints (digits-only, missing country) get amber.
  const strong =
    signature === 'us_state_non_us_coords' ||
    signature === 'plus1_non_us_coords';
  return (
    <span
      style={{
        background: strong ? 'var(--red-subtle)' : 'var(--amber-subtle)',
        color: strong ? 'var(--red)' : 'var(--amber)',
        fontSize: '11px',
        fontWeight: 500,
        padding: '2px 6px',
        borderRadius: '4px',
        display: 'inline-block',
        whiteSpace: 'nowrap',
      }}
    >
      {CORRUPT_SIG_LABELS[signature]}
    </span>
  );
}

function ReadyStateBadge({
  needsResolve,
}: {
  needsResolve: boolean;
}) {
  if (needsResolve) {
    return (
      <span
        style={{
          background: 'var(--amber-subtle)',
          color: 'var(--amber)',
          fontSize: '11px',
          fontWeight: 600,
          padding: '2px 6px',
          borderRadius: '4px',
          display: 'inline-block',
          whiteSpace: 'nowrap',
        }}
      >
        needs re-resolve
      </span>
    );
  }
  return (
    <span
      style={{
        background: 'var(--green-subtle)',
        color: 'var(--green)',
        fontSize: '11px',
        fontWeight: 600,
        padding: '2px 6px',
        borderRadius: '4px',
        display: 'inline-block',
        whiteSpace: 'nowrap',
      }}
    >
      ready to parse
    </span>
  );
}

// Renders an address block with optional diff highlighting against a
// reference set (current). When highlight=true, fields that differ
// from the reference are bolded to draw the operator's eye to the
// real change — the rest stays muted.
function AddressBlock({
  components,
  current,
  highlight,
}: {
  components: AddressComponents;
  current?: AddressComponents;
  highlight?: boolean;
}) {
  const diff = (key: keyof AddressComponents): boolean => {
    if (!highlight || !current) return false;
    const a = String(components[key] ?? '').trim().toLowerCase();
    const b = String(current[key] ?? '').trim().toLowerCase();
    return a !== b;
  };
  const row = (label: string, value: string | null, k: keyof AddressComponents) => (
    <div
      style={{
        display: 'flex',
        gap: '6px',
        fontSize: '12px',
        color: diff(k) ? 'var(--text)' : 'var(--text-muted)',
        fontWeight: diff(k) ? 600 : 400,
      }}
    >
      <span style={{ minWidth: '64px', textTransform: 'uppercase' }}>
        {label}
      </span>
      <span style={{ wordBreak: 'break-word' }}>{value || '—'}</span>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      {row('Addr', components.address1, 'address1')}
      {row('City', components.city, 'city')}
      {row('State', components.state, 'state')}
      {row('Postal', components.postalCode, 'postalCode')}
      {row('Country', components.country, 'country')}
      {row('CC', components.countryCode, 'countryCode')}
    </div>
  );
}

// ─── styles ───────────────────────────────────────────────────────────────

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

const codeStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  color: 'var(--text-muted)',
  background: 'var(--surface-elevated)',
  padding: '2px 6px',
  borderRadius: '4px',
  display: 'inline-block',
  maxWidth: '400px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

