import { useState } from 'react';
import { X, AlertCircle, AlertTriangle, Info, Pencil } from 'lucide-react';
import type { SeedingRecord } from '@pinntag-dop/types';
import { BotProgressDetail } from '../ui/BotProgressBar';
import {
  useCvbApplyFix,
  useCvbRejectFix,
  useUpdateRecord,
} from '../../hooks/use-sessions';

const EDITABLE_TEXT_FIELDS: {
  key: string;
  label: string;
  altKeys?: string[];
  placeholder?: string;
}[] = [
  { key: 'name', label: 'Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'countryCode', label: 'Country code' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Website' },
  { key: 'address1', label: 'Address line 1', altKeys: ['addressLine1'] },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'postalCode', label: 'Postal code', altKeys: ['zip'] },
  { key: 'description', label: 'Description' },
];

const READONLY_FIELDS: { key: string; label: string }[] = [
  { key: 'industry', label: 'Industry' },
  { key: 'categories', label: 'Categories' },
  { key: 'placeId', label: 'Place ID' },
  { key: 'latitude', label: 'Latitude' },
  { key: 'longitude', label: 'Longitude' },
  { key: 'rating', label: 'Rating' },
  { key: 'userRatingCount', label: 'User rating count' },
];

const FIELD_LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: '4px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const TEXT_INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  fontSize: '13px',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  background: 'var(--surface-elevated)',
  color: 'var(--text)',
  outline: 'none',
  boxSizing: 'border-box',
};

function resolveValue(
  data: Record<string, any>,
  key: string,
  altKeys?: string[],
): any {
  if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
    return data[key];
  }
  for (const alt of altKeys ?? []) {
    if (data[alt] !== undefined && data[alt] !== null && data[alt] !== '') {
      return data[alt];
    }
  }
  return data[key] ?? '';
}

function formatReadonly(value: any): string {
  if (value === undefined || value === null || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const SEVERITY_COLOR: Record<string, {
  bg: string; text: string; icon: string;
}> = {
  error:   { bg: '#FEF2F2', text: '#DC2626', icon: '#DC2626' },
  warning: { bg: '#FFFBEB', text: '#D97706', icon: '#D97706' },
  info:    { bg: '#EFF6FF', text: '#1A6BFF', icon: '#1A6BFF' },
};

function SeverityIcon({ severity }: { severity: string }) {
  const size = 13;
  const color = SEVERITY_COLOR[severity]?.icon ?? 'var(--text-muted)';
  if (severity === 'error')
    return <AlertCircle size={size} style={{ color }} />;
  if (severity === 'warning')
    return <AlertTriangle size={size} style={{ color }} />;
  return <Info size={size} style={{ color }} />;
}

function DataSection({
  title,
  data,
}: {
  title: string;
  data: Record<string, any>;
}) {
  return (
    <div style={{ marginBottom: '20px' }}>
      <p style={{
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--text-muted)',
        fontWeight: 500,
        marginBottom: '10px',
      }}>
        {title}
      </p>
      <div style={{
        backgroundColor: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        overflow: 'hidden',
      }}>
        {Object.entries(data)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([key, value], i, arr) => (
            <div
              key={key}
              style={{
                display: 'grid',
                gridTemplateColumns: '140px 1fr',
                gap: '8px',
                padding: '8px 12px',
                borderBottom: i < arr.length - 1
                  ? '1px solid var(--border)' : 'none',
                alignItems: 'start',
              }}
            >
              <span style={{
                fontSize: '12px',
                color: 'var(--text-secondary)',
                fontFamily: 'monospace',
                paddingTop: '1px',
              }}>
                {key}
              </span>
              <span style={{
                fontSize: '12px',
                color: 'var(--text)',
                wordBreak: 'break-all',
                lineHeight: 1.5,
              }}>
                {typeof value === 'object'
                  ? JSON.stringify(value, null, 2)
                  : String(value)}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

export function RecordDetailPanel({
  record,
  onClose,
}: {
  record: SeedingRecord;
  onClose: () => void;
}) {
  const applyFix = useCvbApplyFix();
  const rejectFix = useCvbRejectFix();
  const updateRecord = useUpdateRecord();

  const baseData =
    (record.transformedData as Record<string, any>) ||
    (record.rawData as Record<string, any>) ||
    {};

  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Record<string, any>>({});

  const data = isEditing ? editData : baseData;

  const handleStartEdit = () => {
    setEditData({ ...baseData });
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditData({});
  };

  const handleSave = async () => {
    try {
      await updateRecord.mutateAsync({
        recordId: record._id,
        update: {
          transformedData: editData,
          rawData: editData,
        },
      });
      setIsEditing(false);
    } catch (err: any) {
      alert(
        err?.response?.data?.message ??
          err?.message ??
          'Failed to update record',
      );
    }
  };

  return (
    <div style={{
      backgroundColor: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: '10px',
      overflow: 'hidden',
      position: 'sticky',
      top: '80px',
      maxHeight: 'calc(100vh - 100px)',
      display: 'flex',
      flexDirection: 'column',
    }}>

      {/* Panel header */}
      <div style={{
        padding: '14px 16px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            <span style={{
              fontSize: '12px',
              fontWeight: 500,
              color: 'var(--text)',
              backgroundColor: 'var(--surface-elevated)',
              padding: '2px 8px',
              borderRadius: '4px',
            }}>
              {record.module}
            </span>
            <span style={{
              fontFamily: 'monospace',
              fontSize: '11px',
              color: 'var(--text-muted)',
            }}>
              {record._id.slice(-8)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {!isEditing && record.status !== 'published' && (
              <button
                onClick={handleStartEdit}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '12px',
                  fontWeight: 500,
                  color: 'var(--text)',
                  background: 'var(--surface-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '4px 10px',
                  cursor: 'pointer',
                }}
              >
                <Pencil size={12} />
                Edit
              </button>
            )}
            <button
              onClick={onClose}
              style={{
                color: 'var(--text-muted)',
                cursor: 'pointer',
                background: 'none',
                border: 'none',
                display: 'flex',
                padding: '4px',
                borderRadius: '4px',
              }}
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {record.publishedId && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginTop: '6px',
          }}>
            <span style={{
              fontSize: '10px',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              PinnTag ID
            </span>
            <span
              style={{
                fontFamily: 'monospace',
                fontSize: '12px',
                color: '#16A34A',
                backgroundColor: '#F0FDF4',
                padding: '3px 8px',
                borderRadius: '4px',
                letterSpacing: '0.02em',
              }}
            >
              {record.publishedId}
            </span>
          </div>
        )}
      </div>

      {/* Scrollable content */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px',
      }}>

        {/* Visual header: logo + name + category */}
        <div style={{
          display: 'flex',
          gap: '12px',
          marginBottom: '16px',
          paddingBottom: '16px',
          borderBottom: '1px solid var(--border)',
        }}>
          <div>
            {data.logo ? (
              <img
                src={data.logo}
                alt="Logo"
                style={{
                  width: '56px',
                  height: '56px',
                  borderRadius: '10px',
                  objectFit: 'cover',
                  border: '1px solid var(--border)',
                }}
                onError={(e) => {
                  (e.target as HTMLImageElement).src = '';
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <div style={{
                width: '56px',
                height: '56px',
                borderRadius: '10px',
                background: 'var(--surface-elevated)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '20px',
                fontWeight: 700,
                color: 'var(--text-muted)',
              }}>
                {(data.name || '?')[0]?.toUpperCase()}
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: '15px',
              fontWeight: 600,
              color: 'var(--text)',
            }}>
              {data.name || 'Unnamed'}
            </div>
            <div style={{
              fontSize: '12px',
              color: 'var(--text-secondary)',
              marginTop: '2px',
            }}>
              {data.industry}
              {Array.isArray(data.categories) && data.categories[0]
                ? ` · ${data.categories[0]}`
                : ''}
            </div>
          </div>
        </div>

        {/* Cover preview */}
        {data.cover && (
          <div style={{ marginBottom: '16px' }}>
            <img
              src={data.cover}
              alt="Cover"
              style={{
                width: '100%',
                height: '140px',
                borderRadius: '8px',
                objectFit: 'cover',
                border: '1px solid var(--border)',
              }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          </div>
        )}

        {/* Logo URL + preview */}
        <div style={{ marginBottom: '12px' }}>
          <label style={FIELD_LABEL_STYLE}>Logo</label>
          {data.logo ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
            }}>
              <img
                src={data.logo}
                alt="Logo"
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '8px',
                  objectFit: 'cover',
                  border: '1px solid var(--border)',
                  background: 'var(--surface-elevated)',
                  flexShrink: 0,
                }}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
              {isEditing && (
                <input
                  type="text"
                  value={editData.logo || ''}
                  onChange={(e) =>
                    setEditData({ ...editData, logo: e.target.value })
                  }
                  style={{ ...TEXT_INPUT_STYLE, flex: 1, fontSize: '12px' }}
                  placeholder="Logo URL"
                />
              )}
            </div>
          ) : isEditing ? (
            <input
              type="text"
              value={editData.logo || ''}
              onChange={(e) =>
                setEditData({ ...editData, logo: e.target.value })
              }
              style={{ ...TEXT_INPUT_STYLE, fontSize: '12px' }}
              placeholder="Logo URL"
            />
          ) : (
            <span style={{
              fontSize: '12px',
              color: 'var(--text-muted)',
            }}>
              No logo
            </span>
          )}
        </div>

        {/* Cover URL */}
        <div style={{ marginBottom: '16px' }}>
          <label style={FIELD_LABEL_STYLE}>Cover</label>
          {data.cover ? (
            <div>
              <img
                src={data.cover}
                alt="Cover"
                style={{
                  width: '100%',
                  maxWidth: '300px',
                  height: '120px',
                  borderRadius: '8px',
                  objectFit: 'cover',
                  border: '1px solid var(--border)',
                  background: 'var(--surface-elevated)',
                  marginBottom: isEditing ? '6px' : '0',
                }}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
              {isEditing && (
                <input
                  type="text"
                  value={editData.cover || ''}
                  onChange={(e) =>
                    setEditData({ ...editData, cover: e.target.value })
                  }
                  style={{ ...TEXT_INPUT_STYLE, fontSize: '12px' }}
                  placeholder="Cover URL"
                />
              )}
            </div>
          ) : isEditing ? (
            <input
              type="text"
              value={editData.cover || ''}
              onChange={(e) =>
                setEditData({ ...editData, cover: e.target.value })
              }
              style={{ ...TEXT_INPUT_STYLE, fontSize: '12px' }}
              placeholder="Cover URL"
            />
          ) : (
            <span style={{
              fontSize: '12px',
              color: 'var(--text-muted)',
            }}>
              No cover
            </span>
          )}
        </div>

        {/* Editable fields */}
        <div style={{ marginBottom: '16px' }}>
          {EDITABLE_TEXT_FIELDS.map((field) => {
            const value = isEditing
              ? editData[field.key] ?? ''
              : resolveValue(baseData, field.key, field.altKeys);
            return (
              <div key={field.key} style={{ marginBottom: '12px' }}>
                <label style={FIELD_LABEL_STYLE}>{field.label}</label>
                {isEditing ? (
                  <input
                    type="text"
                    value={value || ''}
                    onChange={(e) =>
                      setEditData({
                        ...editData,
                        [field.key]: e.target.value,
                      })
                    }
                    style={TEXT_INPUT_STYLE}
                  />
                ) : (
                  <span style={{
                    fontSize: '13px',
                    color: 'var(--text)',
                    wordBreak: 'break-word',
                  }}>
                    {value === '' || value === null || value === undefined
                      ? '—'
                      : String(value)}
                  </span>
                )}
              </div>
            );
          })}

          {/* Tags */}
          <div style={{ marginBottom: '12px' }}>
            <label style={FIELD_LABEL_STYLE}>Tags</label>
            {isEditing ? (
              <input
                type="text"
                value={
                  Array.isArray(editData.tags)
                    ? editData.tags.join(', ')
                    : ''
                }
                onChange={(e) =>
                  setEditData({
                    ...editData,
                    tags: e.target.value
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
                style={TEXT_INPUT_STYLE}
                placeholder="tag1, tag2, tag3"
              />
            ) : (
              <span style={{ fontSize: '13px', color: 'var(--text)' }}>
                {Array.isArray(baseData.tags) && baseData.tags.length > 0
                  ? baseData.tags.join(', ')
                  : '—'}
              </span>
            )}
          </div>
        </div>

        {/* Read-only fields */}
        <div style={{
          marginBottom: '16px',
          paddingTop: '12px',
          borderTop: '1px solid var(--border)',
        }}>
          <p style={{
            fontSize: '11px',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--text-muted)',
            fontWeight: 500,
            marginBottom: '10px',
          }}>
            Read-only
          </p>
          {READONLY_FIELDS.map((field) => (
            <div key={field.key} style={{ marginBottom: '8px' }}>
              <label style={FIELD_LABEL_STYLE}>{field.label}</label>
              <span style={{
                fontSize: '13px',
                color: 'var(--text)',
                wordBreak: 'break-word',
              }}>
                {formatReadonly(baseData[field.key])}
              </span>
            </div>
          ))}
        </div>

        {/* Save / Cancel */}
        {isEditing && (
          <div style={{
            display: 'flex',
            gap: '8px',
            marginTop: '16px',
            paddingTop: '16px',
            borderTop: '1px solid var(--border)',
          }}>
            <button
              onClick={handleSave}
              disabled={updateRecord.isPending}
              style={{
                padding: '6px 16px',
                fontSize: '13px',
                fontWeight: 500,
                background: 'var(--accent, #1A6BFF)',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: updateRecord.isPending ? 'wait' : 'pointer',
                opacity: updateRecord.isPending ? 0.7 : 1,
              }}
            >
              {updateRecord.isPending ? 'Saving…' : 'Save changes'}
            </button>
            <button
              onClick={handleCancelEdit}
              disabled={updateRecord.isPending}
              style={{
                padding: '6px 16px',
                fontSize: '13px',
                fontWeight: 500,
                background: 'var(--surface-elevated)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Bot scrape progress */}
        {record.botScrape && (
          <BotProgressDetail botScrape={record.botScrape} />
        )}

        {/* CVB fixes */}
        {record.cvbFixes && record.cvbFixes.length > 0 && (
          <div style={{
            marginTop: '16px',
            padding: '16px',
            backgroundColor: 'var(--bg)',
            borderRadius: '8px',
            border: '1px solid var(--border)',
          }}>
            <div style={{
              fontSize: '12px',
              fontWeight: 500,
              color: 'var(--text)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: '12px',
            }}>
              Data Issues ({record.cvbFixes.length})
            </div>

            {record.cvbFixes.map((fix, i) => (
              <div key={i} style={{
                padding: '10px 0',
                borderBottom: '1px solid var(--surface-elevated)',
              }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  marginBottom: '4px',
                }}>
                  <div>
                    <span style={{
                      fontSize: '12px',
                      fontWeight: 500,
                      color: 'var(--text)',
                    }}>
                      {fix.field}
                    </span>
                    <span style={{
                      fontSize: '11px',
                      color: 'var(--text-secondary)',
                      marginLeft: '8px',
                    }}>
                      {fix.issue}
                    </span>
                  </div>
                  <span style={{
                    fontSize: '10px',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    backgroundColor: fix.riskLevel === 'safe'
                      ? '#F0FDF4' : '#FFF7ED',
                    color: fix.riskLevel === 'safe'
                      ? '#16A34A' : '#D97706',
                    fontWeight: 500,
                  }}>
                    {fix.riskLevel === 'safe' ? 'Safe' : 'Manual'}
                  </span>
                </div>

                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '8px',
                  marginBottom: '8px',
                  fontSize: '11px',
                }}>
                  <div style={{
                    padding: '4px 8px',
                    backgroundColor: '#FEF2F2',
                    borderRadius: '4px',
                    color: '#DC2626',
                  }}>
                    Current: {fix.currentValue !== null
                      ? JSON.stringify(fix.currentValue)
                      : '(empty)'}
                  </div>
                  {fix.suggestedValue === '__fetch_from_bot__' ? (
                    <div style={{
                      padding: '4px 8px',
                      backgroundColor: '#EFF6FF',
                      borderRadius: '4px',
                      color: '#2563EB',
                      fontSize: '11px',
                    }}>
                      🤖 Auto-fetch via bot scrape
                    </div>
                  ) : fix.suggestedValue === '__fetch_from_enrichment__' ? (
                    <div style={{
                      padding: '4px 8px',
                      backgroundColor: '#F0FDF4',
                      borderRadius: '4px',
                      color: '#16A34A',
                      fontSize: '11px',
                    }}>
                      📍 Auto-fetch via Google Places
                    </div>
                  ) : (
                    <div style={{
                      padding: '4px 8px',
                      backgroundColor: '#F0FDF4',
                      borderRadius: '4px',
                      color: '#16A34A',
                    }}>
                      Fix: {fix.suggestedValue !== null
                        ? JSON.stringify(fix.suggestedValue)
                        : '(needs manual input)'}
                    </div>
                  )}
                </div>

                {fix.status === 'pending' && (
                  <div style={{
                    display: 'flex',
                    gap: '6px',
                  }}>
                    {fix.suggestedValue !== null &&
                     fix.suggestedValue !== '__fetch_from_bot__' &&
                     fix.suggestedValue !== '__fetch_from_enrichment__' && (
                      <button
                        onClick={() => applyFix.mutate({
                          recordId: record._id,
                          field: fix.field,
                          value: fix.suggestedValue,
                          mode: 'manual',
                        })}
                        style={{
                          fontSize: '11px',
                          padding: '4px 10px',
                          backgroundColor: 'var(--text)',
                          color: 'var(--surface)',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                        }}
                      >
                        Apply fix
                      </button>
                    )}
                    <button
                      onClick={() => rejectFix.mutate({
                        recordId: record._id,
                        field: fix.field,
                      })}
                      style={{
                        fontSize: '11px',
                        padding: '4px 10px',
                        backgroundColor: 'transparent',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border)',
                        borderRadius: '4px',
                        cursor: 'pointer',
                      }}
                    >
                      Reject
                    </button>
                  </div>
                )}

                {fix.status === 'applied' && (
                  <span style={{
                    fontSize: '11px',
                    color: '#16A34A',
                  }}>
                    ✓ Applied {fix.appliedBy
                      ? `by ${fix.appliedBy}` : ''}
                  </span>
                )}

                {fix.status === 'rejected' && (
                  <span style={{
                    fontSize: '11px',
                    color: 'var(--text-muted)',
                  }}>
                    ✗ Rejected
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Validation errors */}
        {record.validationErrors &&
          record.validationErrors.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <p style={{
              fontSize: '11px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-muted)',
              fontWeight: 500,
              marginBottom: '10px',
            }}>
              Validation
            </p>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}>
              {record.validationErrors.map((err, i) => {
                const s = SEVERITY_COLOR[err.severity] ??
                  SEVERITY_COLOR.info;
                return (
                  <div key={i} style={{
                    display: 'flex',
                    gap: '8px',
                    padding: '8px 12px',
                    backgroundColor: s.bg,
                    borderRadius: '6px',
                    alignItems: 'flex-start',
                  }}>
                    <SeverityIcon severity={err.severity} />
                    <div>
                      <span style={{
                        fontSize: '11px',
                        fontWeight: 500,
                        color: s.text,
                        fontFamily: 'monospace',
                        marginRight: '6px',
                      }}>
                        {err.field}
                      </span>
                      <span style={{
                        fontSize: '12px',
                        color: s.text,
                      }}>
                        {err.message}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Raw data */}
        {record.rawData && (
          <DataSection title="Raw data" data={record.rawData} />
        )}

        {/* Transformed data */}
        {record.transformedData && (
          <DataSection
            title="Transformed data"
            data={record.transformedData}
          />
        )}

        {/* Enriched data */}
        {record.enrichmentData && (
          <DataSection
            title="Enriched data"
            data={record.enrichmentData}
          />
        )}

      </div>
    </div>
  );
}
