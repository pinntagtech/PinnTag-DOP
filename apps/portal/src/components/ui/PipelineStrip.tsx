import type { SeedingStats } from '@pinntag-dop/types';

const STAGES = [
  { key: 'raw', label: 'Raw' },
  { key: 'validated', label: 'Validated' },
  { key: 'transformed', label: 'Transformed' },
  { key: 'enriched', label: 'Enriched' },
  { key: 'ready', label: 'Ready' },
  { key: 'published', label: 'Published' },
] as const;

export function PipelineStrip({ stats }: { stats: SeedingStats }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0',
        padding: '4px 0',
      }}
    >
      {STAGES.map((stage, i) => {
        const count = stats[stage.key] ?? 0;
        const isActive = count > 0;
        const isDone = i < STAGES.length - 1 && isActive;
        const totalDone =
          (stats.published ?? 0) > 0 && stage.key !== 'published';
        const showCheck = totalDone && isActive;
        return (
          <div
            key={stage.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              flex: 1,
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '6px',
                flex: 1,
              }}
            >
              <div
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: showCheck
                    ? 'var(--green-subtle)'
                    : isActive
                    ? 'var(--accent)'
                    : 'var(--surface-elevated)',
                  color: showCheck
                    ? 'var(--green)'
                    : isActive
                    ? '#ffffff'
                    : 'var(--text-muted)',
                  transition: 'all 0.15s',
                }}
              >
                {showCheck ? '✓' : i + 1}
              </div>
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: isActive
                    ? 'var(--text)'
                    : 'var(--text-muted)',
                }}
              >
                {stage.label}
              </span>
              <span
                style={{
                  fontSize: '13px',
                  color: isActive
                    ? 'var(--text)'
                    : 'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {count}
              </span>
            </div>
            {i < STAGES.length - 1 && (
              <span
                style={{
                  color: isDone
                    ? 'var(--accent)'
                    : 'var(--border-strong)',
                  fontSize: '12px',
                  marginTop: '-22px',
                }}
              >
                →
              </span>
            )}
          </div>
        );
      })}
      {stats.failed > 0 && (
        <div
          style={{
            marginLeft: '16px',
            padding: '4px 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--red-subtle)',
            border: '1px solid var(--red)',
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--red)',
            letterSpacing: '0.05em',
          }}
        >
          {stats.failed} FAILED
        </div>
      )}
    </div>
  );
}
