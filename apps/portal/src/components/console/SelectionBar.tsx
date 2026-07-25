import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { ConsoleSelection } from '../../hooks/use-business-console';
import { useSelectionPreview } from '../../hooks/use-business-console';

// The selection contract:
//   { mode: 'ids', ids: [...] }               → shown as N selected
//   { mode: 'filter', filter, excludeIds }    → shown as "all M matching (K excluded)"
//
// The bar always shows exactly what the next action will operate on.
// A user should never be able to click Apply without seeing the size.
export function SelectionBar({
  environment,
  selection,
  onClear,
  onSelectAllMatching,
  showSelectAllMatching,
  matchingTotal,
  currentPageIds,
  onSelectAllOnPage,
  children,
}: {
  environment: string;
  selection: ConsoleSelection | null;
  onClear: () => void;
  onSelectAllMatching?: () => void;
  showSelectAllMatching?: boolean;
  matchingTotal?: number;
  currentPageIds?: string[];
  onSelectAllOnPage?: () => void;
  children?: React.ReactNode;
}) {
  const preview = useSelectionPreview();

  // Ask the server for the exact selection count whenever it changes.
  // mode:ids counts locally; mode:filter always round-trips so the
  // number the user sees before clicking Apply is authoritative.
  useEffect(() => {
    if (!selection) return;
    if (selection.mode === 'ids') return;
    preview.mutate({ environment, selection });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environment, JSON.stringify(selection)]);

  const nothingSelected =
    !selection ||
    (selection.mode === 'ids' && selection.ids.length === 0);

  if (nothingSelected) {
    // Nothing selected — show the "select all on page" affordance when
    // there IS a page to act on, and nothing else. Keeps the bar quiet
    // when the user hasn't engaged with selection yet.
    if (!currentPageIds?.length) return null;
    return (
      <div style={containerStyle}>
        <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
          Nothing selected.
        </span>
        {onSelectAllOnPage && (
          <button style={linkBtn} onClick={onSelectAllOnPage}>
            Select all {currentPageIds.length} on this page
          </button>
        )}
        <div style={{ flex: 1 }} />
        {children}
      </div>
    );
  }

  const idCount =
    selection.mode === 'ids'
      ? selection.ids.length
      : (preview.data?.total ?? 0);

  const summary =
    selection.mode === 'ids'
      ? `Selected: ${idCount.toLocaleString()} record${idCount === 1 ? '' : 's'}`
      : preview.data
        ? `Selected: all ${preview.data.total.toLocaleString()} matching current filter` +
          ((selection.excludeIds?.length ?? 0) > 0
            ? ` (${selection.excludeIds!.length} excluded)`
            : '')
        : 'Resolving selection…';

  return (
    <div style={containerStyle}>
      <span
        style={{
          fontSize: '12px',
          color: 'var(--text)',
          fontWeight: 500,
        }}
      >
        {summary}
      </span>
      <span
        style={{
          fontSize: '10px',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          padding: '2px 6px',
          borderRadius: '4px',
          background:
            selection.mode === 'filter'
              ? 'rgba(139, 92, 246, 0.14)'
              : 'rgba(59, 130, 246, 0.12)',
          color:
            selection.mode === 'filter'
              ? 'var(--accent, #8b5cf6)'
              : 'var(--text-secondary)',
        }}
      >
        {selection.mode}
      </span>

      <button style={linkBtn} onClick={onClear}>
        <X size={11} style={{ marginRight: '2px' }} /> Clear
      </button>

      {showSelectAllMatching &&
        onSelectAllMatching &&
        selection.mode === 'ids' && (
          <button style={linkBtn} onClick={onSelectAllMatching}>
            Select all {matchingTotal?.toLocaleString() ?? '?'} matching filter
          </button>
        )}

      <div style={{ flex: 1 }} />
      {children}
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '10px 14px',
  background: 'var(--surface-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  fontFamily: 'var(--font)',
};

const linkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  cursor: 'pointer',
  padding: '2px 4px',
  display: 'inline-flex',
  alignItems: 'center',
};
