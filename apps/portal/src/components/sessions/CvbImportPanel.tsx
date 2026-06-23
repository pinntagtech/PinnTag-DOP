import { useState, useEffect } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  useCvbBusinesses,
  useCvbFilters,
  useImportCvb,
} from '../../hooks/use-sessions';

type CvbBusiness = {
  _id: string;
  name?: string;
  city?: string;
  state?: string;
  phone?: string;
  email?: string;
  placeId?: string;
  industryName?: string | null;
  categoryNames?: string[];
};

interface Props {
  sessionId: string;
  environment: string;
  onImported: () => void;
  onTotalLoaded?: (total: number) => void;
}

export function CvbImportPanel({
  sessionId,
  onImported,
  onTotalLoaded,
}: Props) {
  const [search, setSearch] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [industry, setIndustry] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [sortBy, setSortBy] = useState<
    'newest' | 'oldest' | 'name'
  >('newest');
  const [hasPlaceId, setHasPlaceId] = useState<boolean | undefined>(undefined);
  const [hasMissingFields, setHasMissingFields] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [toast, setToast] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const { data: filters } = useCvbFilters();
  const businesses = useCvbBusinesses({
    city: city || undefined,
    state: state || undefined,
    industry: industry || undefined,
    category: filterCategory || undefined,
    search: search || undefined,
    hasPlaceId,
    hasMissingFields,
    sortBy,
    page,
    limit: 20,
  });
  const importCvb = useImportCvb();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Load the initial unfiltered total on mount so the count
  // shows up before the operator clicks Search.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    businesses.refetch();
  }, []);

  // Bubble the total up to the parent for the tab label.
  useEffect(() => {
    if (businesses.data && onTotalLoaded) {
      onTotalLoaded(businesses.data.total);
    }
  }, [businesses.data, onTotalLoaded]);

  const handleSearch = () => {
    setPage(1);
    businesses.refetch();
  };

  const toggleSelect = (b: CvbBusiness) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(b._id)) {
        next.delete(b._id);
      } else {
        next.set(b._id, b.name || '(no name)');
      }
      return next;
    });
  };

  const handleImport = async () => {
    if (selected.size === 0) return;
    try {
      const result = await importCvb.mutateAsync({
        sessionId,
        businessIds: Array.from(selected.keys()),
      });
      setToast(
        `✓ Imported ${result.imported} businesses. ${result.skipped} skipped.`,
      );
      if (result.duplicates && result.duplicates.length > 0) {
        setWarning(
          `${result.duplicates.length} businesses already imported in this session`,
        );
      } else {
        setWarning(null);
      }
      setSelected(new Map());
      onImported();
    } catch (err: any) {
      alert(err?.response?.data?.message ?? err.message ?? 'Import failed');
    }
  };

  const list = (businesses.data?.businesses ?? []) as CvbBusiness[];
  const pages = businesses.data?.pages ?? 1;

  const activeFilters = {
    search,
    city,
    state,
    industry,
    filterCategory,
    hasPlaceId: hasPlaceId === true,
    hasMissingFields,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Filter bar */}
      <div style={{
        display: 'flex',
        gap: '8px',
        flexWrap: 'wrap',
        alignItems: 'center',
        marginBottom: '12px',
      }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name / phone / email"
          style={{
            flex: 1,
            minWidth: '200px',
            height: '32px',
            padding: '0 10px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            fontSize: '13px',
            outline: 'none',
          }}
        />

        <select
          value={city}
          onChange={(e) => setCity(e.target.value)}
          style={{ ...selectStyle, minWidth: '120px' }}
        >
          <option value="">All cities</option>
          {(filters?.cities ?? []).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <select
          value={state}
          onChange={(e) => setState(e.target.value)}
          style={{ ...selectStyle, minWidth: '100px' }}
        >
          <option value="">All states</option>
          {(filters?.states ?? []).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
          style={{ ...selectStyle, minWidth: '140px' }}
        >
          <option value="">All industries</option>
          {(filters?.industries ?? []).map((i) => (
            <option key={i._id} value={i._id}>{i.name}</option>
          ))}
        </select>

        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          style={{ ...selectStyle, minWidth: '140px' }}
        >
          <option value="">All categories</option>
          {(filters?.categories ?? []).map((c) => (
            <option key={c._id} value={c._id}>{c.name}</option>
          ))}
        </select>

        <select
          value={sortBy}
          onChange={(e) =>
            setSortBy(e.target.value as 'newest' | 'oldest' | 'name')
          }
          style={{ ...selectStyle, minWidth: '130px' }}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name A-Z</option>
        </select>

        <label style={toggleStyle}>
          <input
            type="checkbox"
            checked={hasMissingFields}
            onChange={(e) => setHasMissingFields(e.target.checked)}
          />
          Missing fields only
        </label>

        <label style={toggleStyle}>
          <input
            type="checkbox"
            checked={hasPlaceId === true}
            onChange={(e) =>
              setHasPlaceId(e.target.checked ? true : undefined)
            }
          />
          Has Place ID
        </label>

        <button
          onClick={handleSearch}
          disabled={businesses.isFetching}
          style={{
            height: '32px',
            padding: '0 16px',
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--radius)',
            fontSize: '13px',
            fontWeight: 500,
            cursor: businesses.isFetching ? 'not-allowed' : 'pointer',
            opacity: businesses.isFetching ? 0.7 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {businesses.isFetching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {/* Table panel */}
      <div style={{
        width: '100%',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}>
        {/* Summary bar */}
        {businesses.data && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            borderBottom: '1px solid var(--border)',
          }}>
            <span style={{
              fontSize: '13px',
              color: 'var(--text-secondary)',
            }}>
              <span style={{
                fontWeight: 600,
                color: 'var(--text)',
                fontSize: '15px',
              }}>
                {businesses.data.total.toLocaleString()}
              </span>
              {' '}CVB businesses found
              {Object.values(activeFilters).some(Boolean) && (
                <span style={{
                  marginLeft: '8px',
                  fontSize: '11px',
                  color: 'var(--text-muted)',
                }}>
                  (filtered)
                </span>
              )}
            </span>
            <span style={{
              fontSize: '12px',
              color: 'var(--text-muted)',
            }}>
              Page {businesses.data.page} of {businesses.data.pages}
            </span>
          </div>
        )}

        {/* Results table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            tableLayout: 'auto',
            borderCollapse: 'collapse',
          }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{
                  padding: '12px 16px',
                  textAlign: 'left',
                  width: '40px',
                }}>
                  <input
                    type="checkbox"
                    checked={
                      (businesses.data?.businesses?.length ?? 0) > 0 &&
                      (businesses.data?.businesses ?? []).every(
                        (b: CvbBusiness) =>
                          selected.has(b._id.toString()),
                      )
                    }
                    ref={(el) => {
                      if (el) {
                        el.indeterminate =
                          (businesses.data?.businesses ?? []).some(
                            (b: CvbBusiness) =>
                              selected.has(b._id.toString()),
                          ) === true &&
                          !(businesses.data?.businesses ?? []).every(
                            (b: CvbBusiness) =>
                              selected.has(b._id.toString()),
                          );
                      }
                    }}
                    onChange={(e) => {
                      if (e.target.checked) {
                        const newSelected = new Map(selected);
                        (businesses.data?.businesses ?? []).forEach(
                          (b: CvbBusiness) => {
                            newSelected.set(
                              b._id.toString(),
                              b.name || '(no name)',
                            );
                          },
                        );
                        setSelected(newSelected);
                      } else {
                        const newSelected = new Map(selected);
                        (businesses.data?.businesses ?? []).forEach(
                          (b: CvbBusiness) => {
                            newSelected.delete(b._id.toString());
                          },
                        );
                        setSelected(newSelected);
                      }
                    }}
                    style={{ cursor: 'pointer', width: '14px', height: '14px' }}
                  />
                </th>
                {([
                  ['Name', '20%'],
                  ['City', '10%'],
                  ['Industry', '12%'],
                  ['Categories', '12%'],
                  ['Phone', '11%'],
                  ['Email', '18%'],
                  ['Place ID', '14%'],
                  ['Issues', '60px'],
                ] as const).map(([h, w]) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left',
                      fontSize: '11px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--text-muted)',
                      fontWeight: 500,
                      padding: '10px 12px',
                      whiteSpace: 'nowrap',
                      width: w,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr>
                  <td colSpan={9} style={{
                    padding: '32px',
                    textAlign: 'center',
                    fontSize: '13px',
                    color: 'var(--text-muted)',
                  }}>
                    {businesses.isFetched
                      ? 'No CVB businesses match your filters'
                      : 'Click Search to load businesses'}
                  </td>
                </tr>
              )}
              {list.map((b) => {
                const isChecked = selected.has(b._id);
                const issues =
                  (b.phone ? 0 : 1) +
                  (b.email ? 0 : 1) +
                  (b.placeId ? 0 : 1);
                return (
                  <tr
                    key={b._id}
                    style={{
                      borderBottom: '1px solid var(--surface-elevated)',
                      backgroundColor: isChecked ? '#EFF6FF' : 'transparent',
                    }}
                  >
                    <td style={{ padding: '10px 12px' }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelect(b)}
                        style={{ cursor: 'pointer' }}
                      />
                    </td>
                    <td style={{
                      padding: '10px 12px',
                      fontSize: '13px',
                      fontWeight: 500,
                      color: 'var(--text)',
                    }}>
                      {b.name || '(no name)'}
                    </td>
                    <td style={{
                      padding: '10px 12px',
                      fontSize: '12px',
                      color: 'var(--text-secondary)',
                    }}>
                      {b.city ? `${b.city}${b.state ? ', ' + b.state : ''}` : '—'}
                    </td>
                    <td style={{
                      padding: '10px 12px',
                      fontSize: '12px',
                      color: 'var(--text-secondary)',
                    }}>
                      {b.industryName || '—'}
                    </td>
                    <td style={{
                      padding: '10px 12px',
                      fontSize: '12px',
                      color: 'var(--text-secondary)',
                    }}>
                      {b.categoryNames?.join(', ') || '—'}
                    </td>
                    <td style={{
                      padding: '10px 12px',
                      fontSize: '12px',
                      color: 'var(--text)',
                    }}>
                      {b.phone ? (
                        b.phone
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <span style={{
                            width: '6px', height: '6px',
                            borderRadius: '50%',
                            backgroundColor: '#DC2626',
                          }} />
                          —
                        </span>
                      )}
                    </td>
                    <td
                      title={b.email}
                      style={{
                        padding: '10px 12px',
                        fontSize: '12px',
                        color: 'var(--text)',
                        maxWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {b.email ? (
                        b.email
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <span style={{
                            width: '6px', height: '6px',
                            borderRadius: '50%',
                            backgroundColor: '#DC2626',
                          }} />
                          —
                        </span>
                      )}
                    </td>
                    <td
                      title={b.placeId}
                      style={{
                        padding: '10px 12px',
                        fontSize: '11px',
                        fontFamily: 'var(--font-mono)',
                        color: b.placeId ? 'var(--text)' : '#D97706',
                        maxWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {b.placeId || '—'}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      {issues > 0 ? (
                        <span style={{
                          fontSize: '11px',
                          fontWeight: 500,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          backgroundColor: '#FFFBEB',
                          color: '#D97706',
                        }}>
                          {issues}
                        </span>
                      ) : (
                        <span style={{
                          fontSize: '12px',
                          color: 'var(--text-muted)',
                        }}>
                          —
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {list.length > 0 && (
          <div style={{
            padding: '10px 16px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '12px',
            color: 'var(--text-secondary)',
          }}>
            <button
              onClick={() => {
                setPage((p) => Math.max(1, p - 1));
                setTimeout(() => businesses.refetch(), 0);
              }}
              disabled={page <= 1}
              style={paginationBtnStyle(page <= 1)}
            >
              <ChevronLeft size={12} /> Previous
            </button>
            <span>
              Page {page} of {pages}
            </span>
            <button
              onClick={() => {
                setPage((p) => Math.min(pages, p + 1));
                setTimeout(() => businesses.refetch(), 0);
              }}
              disabled={page >= pages}
              style={paginationBtnStyle(page >= pages)}
            >
              Next <ChevronRight size={12} />
            </button>
          </div>
        )}
      </div>

      {/* Duplicate-import warning */}
      {warning && (
        <div style={{
          marginTop: '12px',
          padding: '10px 14px',
          backgroundColor: '#FFFBEB',
          border: '1px solid #FDE68A',
          borderRadius: 'var(--radius)',
          fontSize: '12px',
          color: '#B45309',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}>
          <AlertTriangle size={12} />
          {warning}
        </div>
      )}

      {/* Sticky bottom action bar */}
      {selected.size > 0 && (
        <div style={{
          position: 'sticky',
          bottom: 0,
          background: 'var(--surface)',
          borderTop: '1px solid var(--border)',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          zIndex: 10,
          boxShadow: '0 -4px 16px rgba(0,0,0,0.4)',
          borderRadius: '0 0 var(--radius-lg) var(--radius-lg)',
        }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '22px',
            height: '22px',
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: '50%',
            fontSize: '11px',
            fontWeight: 700,
            flexShrink: 0,
          }}>
            {selected.size}
          </span>
          <span style={{
            fontSize: '13px',
            fontWeight: 500,
            color: 'var(--text)',
            whiteSpace: 'nowrap',
          }}>
            selected
          </span>
          <div style={{
            display: 'flex',
            gap: '6px',
            flex: 1,
            overflow: 'hidden',
          }}>
            {Array.from(selected.entries())
              .slice(0, 4)
              .map(([id, name]) => (
                <span
                  key={id}
                  style={{
                    padding: '2px 8px',
                    background: 'var(--accent-subtle)',
                    color: 'var(--accent)',
                    borderRadius: '999px',
                    fontSize: '11px',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    maxWidth: '150px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {name}
                </span>
              ))}
            {selected.size > 4 && (
              <span style={{
                fontSize: '12px',
                color: 'var(--text-muted)',
                alignSelf: 'center',
              }}>
                +{selected.size - 4} more
              </span>
            )}
          </div>
          <button
            onClick={() => setSelected(new Map())}
            style={{
              height: '30px',
              padding: '0 12px',
              background: 'var(--surface-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              fontSize: '12px',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            Clear all
          </button>
          <button
            onClick={handleImport}
            disabled={importCvb.isPending}
            style={{
              height: '30px',
              padding: '0 16px',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 'var(--radius)',
              fontSize: '13px',
              fontWeight: 500,
              color: '#fff',
              cursor: importCvb.isPending
                ? 'not-allowed' : 'pointer',
              opacity: importCvb.isPending ? 0.7 : 1,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {importCvb.isPending
              ? 'Importing...'
              : `Import ${selected.size} businesses`}
          </button>
        </div>
      )}

      {toast && (
        <div style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          backgroundColor: 'var(--text)',
          color: 'var(--surface)',
          padding: '14px 20px',
          borderRadius: '8px',
          fontSize: '13px',
          maxWidth: '420px',
          boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
          zIndex: 200,
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  height: '32px',
  paddingLeft: '8px',
  paddingRight: '24px',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  fontSize: '13px',
  backgroundColor: 'var(--surface)',
  outline: 'none',
  cursor: 'pointer',
};

const toggleStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: '12px',
  color: 'var(--text)',
  cursor: 'pointer',
};

const paginationBtnStyle = (
  disabled: boolean,
): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '4px 10px',
  background: 'none',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  fontSize: '12px',
  color: disabled ? '#D4D4D8' : 'var(--text)',
  cursor: disabled ? 'not-allowed' : 'pointer',
});
