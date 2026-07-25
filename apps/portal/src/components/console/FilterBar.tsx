import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import type {
  ConsoleFilter,
  GateOverall,
} from '../../hooks/use-business-console';

const inputStyle: React.CSSProperties = {
  height: '30px',
  padding: '0 10px',
  fontSize: '12px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  background: 'var(--surface)',
  color: 'var(--text)',
  fontFamily: 'var(--font)',
  outline: 'none',
};

const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' };

// Common resolveStatus.hours values observed in staging. Populated by
// hand rather than fetched — the corpus is frozen and this list is
// small, so an over-engineered "distinct" endpoint isn't worth it.
const RESOLVE_HOURS_STATUSES = [
  'done',
  'pending',
  'review:bot_error:no_search_match',
  'review:bot_error:no_place_id',
  'failed',
];

export function FilterBar({
  filter,
  onChange,
  onClear,
}: {
  filter: ConsoleFilter;
  onChange: (f: ConsoleFilter) => void;
  onClear: () => void;
}) {
  const [qLocal, setQLocal] = useState(filter.q ?? '');

  // Debounce the free-text search so we don't fire a query per
  // keystroke. 300ms feels live and skips the typing burst.
  useEffect(() => {
    if (qLocal === (filter.q ?? '')) return;
    const t = setTimeout(() => {
      onChange({ ...filter, q: qLocal || undefined });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qLocal]);

  useEffect(() => {
    setQLocal(filter.q ?? '');
  }, [filter.q]);

  const hasAny =
    !!filter.q ||
    filter.state?.length ||
    filter.city?.length ||
    typeof filter.isActive === 'boolean' ||
    typeof filter.hasWebsite === 'boolean' ||
    typeof filter.hasEmail === 'boolean' ||
    filter.duplicatePlaceIdOnly ||
    filter.resolveHoursStatus?.length ||
    filter.gateFails?.length ||
    filter.gatePasses?.length ||
    filter.gateOverall !== null;

  return (
    <div
      style={{
        display: 'flex',
        gap: '8px',
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          flex: '1 1 260px',
          minWidth: '200px',
          maxWidth: '360px',
        }}
      >
        <Search
          size={13}
          style={{
            position: 'absolute',
            left: '8px',
            color: 'var(--text-muted)',
            pointerEvents: 'none',
          }}
        />
        <input
          value={qLocal}
          onChange={(e) => setQLocal(e.target.value)}
          placeholder="Search name, address, placeId, email…"
          style={{ ...inputStyle, width: '100%', paddingLeft: '26px' }}
        />
      </div>

      <input
        placeholder="State (e.g. NY)"
        value={filter.state?.[0] ?? ''}
        onChange={(e) =>
          onChange({
            ...filter,
            state: e.target.value ? [e.target.value] : undefined,
          })
        }
        style={{ ...inputStyle, width: '110px' }}
      />
      <input
        placeholder="City"
        value={filter.city?.[0] ?? ''}
        onChange={(e) =>
          onChange({
            ...filter,
            city: e.target.value ? [e.target.value] : undefined,
          })
        }
        style={{ ...inputStyle, width: '140px' }}
      />

      <select
        value={
          typeof filter.isActive === 'boolean'
            ? filter.isActive
              ? 'true'
              : 'false'
            : ''
        }
        onChange={(e) => {
          const v = e.target.value;
          onChange({
            ...filter,
            isActive: v === '' ? undefined : v === 'true',
          });
        }}
        style={selectStyle}
      >
        <option value="">isActive: any</option>
        <option value="true">Active</option>
        <option value="false">Inactive</option>
      </select>

      <select
        value={
          typeof filter.hasWebsite === 'boolean'
            ? filter.hasWebsite
              ? 'true'
              : 'false'
            : ''
        }
        onChange={(e) => {
          const v = e.target.value;
          onChange({
            ...filter,
            hasWebsite: v === '' ? undefined : v === 'true',
          });
        }}
        style={selectStyle}
      >
        <option value="">Website: any</option>
        <option value="true">Has website</option>
        <option value="false">No website</option>
      </select>

      <select
        value={
          typeof filter.hasEmail === 'boolean'
            ? filter.hasEmail
              ? 'true'
              : 'false'
            : ''
        }
        onChange={(e) => {
          const v = e.target.value;
          onChange({
            ...filter,
            hasEmail: v === '' ? undefined : v === 'true',
          });
        }}
        style={selectStyle}
      >
        <option value="">Email: any</option>
        <option value="true">Has email</option>
        <option value="false">No email</option>
      </select>

      <select
        value={filter.resolveHoursStatus?.[0] ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          onChange({
            ...filter,
            resolveHoursStatus: v ? [v] : undefined,
          });
        }}
        style={selectStyle}
      >
        <option value="">resolveStatus.hours: any</option>
        {RESOLVE_HOURS_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          fontSize: '12px',
          color: 'var(--text-secondary)',
          padding: '0 4px',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={!!filter.duplicatePlaceIdOnly}
          onChange={(e) =>
            onChange({
              ...filter,
              duplicatePlaceIdOnly: e.target.checked || undefined,
            })
          }
        />
        Duplicates only
      </label>

      <select
        value={filter.gateOverall ?? ''}
        onChange={(e) => {
          const v = (e.target.value || null) as GateOverall;
          onChange({ ...filter, gateOverall: v });
        }}
        style={selectStyle}
      >
        <option value="">Gate: any</option>
        <option value="passLegacy9">Passes Legacy 9</option>
        <option value="passPerfect11">Passes Perfect 11</option>
        <option value="failAny">Fails any</option>
      </select>

      {hasAny && (
        <button
          onClick={onClear}
          title="Clear all filters"
          style={{
            height: '30px',
            padding: '0 10px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '12px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          <X size={12} /> Clear
        </button>
      )}
    </div>
  );
}
