import { useRef, useState, useCallback, useEffect } from 'react';
import { ChevronDown, ChevronRight, ArrowUp, ArrowDown } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';

interface VirtualDiffListProps<T> {
  title: string;
  count: number;
  rows: T[];
  renderRow: (row: T, index: number) => React.ReactNode;
  estimateRowHeight?: number;
  maxHeightVh?: number;
  defaultCollapsed?: boolean;
  emptyHint?: string;
}

export function VirtualDiffList<T>({
  title,
  count,
  rows,
  renderRow,
  estimateRowHeight = 56,
  maxHeightVh = 70,
  defaultCollapsed = false,
  emptyHint,
}: VirtualDiffListProps<T>) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const parentRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 10,
  });

  // Re-measure when collapse toggles or rows change so first paint after
  // expand is accurate.
  useEffect(() => {
    if (!collapsed) virtualizer.measure();
  }, [collapsed, rows.length, virtualizer]);

  const scrollToTop = useCallback(() => {
    if (rows.length === 0) return;
    virtualizer.scrollToIndex(0, { align: 'start' });
  }, [virtualizer, rows.length]);

  const scrollToBottom = useCallback(() => {
    if (rows.length === 0) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [virtualizer, rows.length]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Home') {
        e.preventDefault();
        scrollToTop();
      } else if (e.key === 'End') {
        e.preventDefault();
        scrollToBottom();
      }
    },
    [scrollToTop, scrollToBottom],
  );

  const showFloatingNav = !collapsed && rows.length > 20;
  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        background: 'var(--surface)',
      }}
    >
      {/* Top collapse header */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          background: 'var(--surface-elevated)',
          border: 'none',
          borderBottom: collapsed ? 'none' : '1px solid var(--border)',
          padding: '8px 12px',
          cursor: 'pointer',
          color: 'var(--text)',
          fontSize: '12px',
          fontWeight: 600,
          textAlign: 'left',
        }}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span>{title}</span>
        <span
          style={{
            color: 'var(--text-muted)',
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 500,
          }}
        >
          ({count.toLocaleString()})
        </span>
      </button>

      {!collapsed && (
        <div style={{ position: 'relative' }}>
          {rows.length === 0 && emptyHint ? (
            <p
              style={{
                fontSize: '12px',
                color: 'var(--text-muted)',
                padding: '12px',
                margin: 0,
              }}
            >
              {emptyHint}
            </p>
          ) : (
            <div
              ref={parentRef}
              tabIndex={0}
              onKeyDown={onKeyDown}
              style={{
                maxHeight: `${maxHeightVh}vh`,
                overflowY: 'auto',
                outline: 'none',
              }}
            >
              <div
                style={{
                  height: totalSize,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {items.map((vi) => (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    {renderRow(rows[vi.index]!, vi.index)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Floating nav buttons — anchored inside this section's box */}
          {showFloatingNav && (
            <div
              style={{
                position: 'absolute',
                right: '12px',
                bottom: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                zIndex: 5,
              }}
            >
              <button
                onClick={scrollToTop}
                title="Jump to top (Home)"
                aria-label="Jump to top"
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '999px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border-strong)',
                  boxShadow: 'var(--shadow-md)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text)',
                }}
              >
                <ArrowUp size={14} />
              </button>
              <button
                onClick={scrollToBottom}
                title="Jump to bottom (End)"
                aria-label="Jump to bottom"
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '999px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border-strong)',
                  boxShadow: 'var(--shadow-md)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text)',
                }}
              >
                <ArrowDown size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Bottom collapse bar (mirrors header) — hidden when collapsed
          since collapsed-state already only shows the top header. */}
      {!collapsed && (
        <button
          onClick={() => setCollapsed(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: '100%',
            background: 'var(--surface-elevated)',
            border: 'none',
            borderTop: '1px solid var(--border)',
            padding: '6px 12px',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
            fontSize: '11px',
            fontWeight: 600,
            textAlign: 'left',
          }}
        >
          <ChevronDown size={12} style={{ transform: 'rotate(180deg)' }} />
          <span>Collapse {title}</span>
          <span
            style={{
              color: 'var(--text-muted)',
              fontVariantNumeric: 'tabular-nums',
              fontWeight: 500,
            }}
          >
            ({count.toLocaleString()})
          </span>
        </button>
      )}
    </div>
  );
}
