import {
  GATE_CRITERIA,
  GATE_CRITERIA_LABELS,
  type ConsoleFacetsResponse,
  type GateCriterion,
} from '../../hooks/use-business-console';

// One clickable chip per criterion, showing the failing count under the
// current filter. Clicking a chip toggles that criterion into
// `gateFails`, which the console AND-composes (a doc must fail ALL of
// the selected chips to appear). The label spells this out — the naive
// read of a chip strip is OR.
export function GateFacets({
  facets,
  selected,
  onToggle,
  loading,
}: {
  facets?: ConsoleFacetsResponse;
  selected: GateCriterion[];
  onToggle: (c: GateCriterion) => void;
  loading?: boolean;
}) {
  const sel = new Set(selected);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '8px',
        }}
      >
        <p
          style={{
            fontSize: '11px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--text-muted)',
            margin: 0,
          }}
        >
          Gate criteria — fail counts (click to filter, AND across chips)
        </p>
        {loading && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            recounting…
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {GATE_CRITERIA.map((c) => {
          const n = facets?.failByCriterion?.[c] ?? 0;
          const active = sel.has(c);
          // c11 has no backing stage yet (hard-coded false) — mark it
          // visually distinct so it's not confused with a real fail.
          const netNew = c === 'c11_verified_name';
          return (
            <button
              key={c}
              onClick={() => onToggle(c)}
              title={
                netNew
                  ? `${GATE_CRITERIA_LABELS[c]} — stage not shipped, always fails`
                  : GATE_CRITERIA_LABELS[c]
              }
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 10px',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--radius)',
                background: active
                  ? 'var(--accent-subtle)'
                  : 'var(--surface-elevated)',
                fontSize: '11px',
                fontFamily: 'var(--font)',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer',
                opacity: netNew ? 0.75 : 1,
                fontWeight: active ? 600 : 500,
              }}
            >
              <span>{GATE_CRITERIA_LABELS[c]}</span>
              <span
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--text)',
                  fontWeight: 700,
                }}
              >
                {n.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
