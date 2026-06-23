import { useState, useRef, useCallback } from 'react';
import {
  X, Upload, FileJson, AlertCircle,
  CheckCircle2, Trash2,
} from 'lucide-react';
import { useUploadRecords } from '../../hooks/use-records';
import { Button } from '../ui/Button';

const MODULES = [
  'business', 'outlet', 'event',
  'event-location', 'event-schedule', 'menu', 'media',
];

interface ParseResult {
  records: Record<string, any>[];
  error?: string;
}

function parseJsonFile(text: string): ParseResult {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return { records: [], error: 'JSON array is empty' };
      }
      return { records: parsed };
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return { records: [parsed] };
    }
    return {
      records: [],
      error: 'JSON must be an array of objects or a single object',
    };
  } catch (e: any) {
    return {
      records: [],
      error: `Invalid JSON: ${e.message}`,
    };
  }
}

export function UploadRecordsModal({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const [module, setModule] = useState('business');
  const [parseResult, setParseResult] =
    useState<ParseResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const upload = useUploadRecords(sessionId);

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.json')) {
      setParseResult({
        records: [],
        error: 'Only .json files are supported',
      });
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setParseResult(parseJsonFile(text));
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleSubmit = async () => {
    if (!parseResult || parseResult.records.length === 0) return;
    setUploadError('');
    try {
      await upload.mutateAsync({
        module,
        records: parseResult.records,
      });
      setUploadSuccess(true);
      setTimeout(() => onClose(), 1500);
    } catch (err: any) {
      setUploadError(err.message ?? 'Upload failed');
    }
  };

  const clearFile = () => {
    setParseResult(null);
    setFileName('');
    setUploadError('');
    setUploadSuccess(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundColor: 'rgba(0,0,0,0.4)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 50,
    }}>
      <div style={{
        backgroundColor: 'var(--surface)',
        borderRadius: '12px',
        width: '560px',
        maxHeight: '85vh',
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid var(--border)',
      }}>

        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '20px 24px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <div>
            <h2 style={{
              fontSize: '15px',
              fontWeight: 500,
              color: 'var(--text)',
              marginBottom: '2px',
            }}>
              Upload records
            </h2>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              JSON array of objects · max 500 records per upload
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              color: 'var(--text-muted)',
              cursor: 'pointer',
              background: 'none',
              border: 'none',
              padding: '4px',
              display: 'flex',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
        }}>

          {/* Module selector */}
          <div>
            <label style={{
              display: 'block',
              fontSize: '12px',
              color: 'var(--text-secondary)',
              marginBottom: '8px',
            }}>
              Module
            </label>
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px',
            }}>
              {MODULES.map((m) => (
                <button
                  key={m}
                  onClick={() => setModule(m)}
                  style={{
                    padding: '4px 12px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: module === m ? 500 : 400,
                    border: module === m
                      ? '1px solid #0A0A0A'
                      : '1px solid var(--border)',
                    backgroundColor: module === m
                      ? 'var(--text)' : 'var(--surface)',
                    color: module === m ? 'var(--surface)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    transition: 'all 150ms',
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Drop zone */}
          {!parseResult ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${isDragging
                  ? '#1A6BFF' : 'var(--border)'}`,
                borderRadius: '10px',
                padding: '40px 24px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '12px',
                cursor: 'pointer',
                backgroundColor: isDragging
                  ? '#EFF6FF' : 'var(--bg)',
                transition: 'all 150ms',
              }}
            >
              <div style={{
                width: '48px',
                height: '48px',
                borderRadius: '10px',
                backgroundColor: 'var(--surface-elevated)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <FileJson size={22} style={{ color: 'var(--text-secondary)' }} />
              </div>
              <div style={{ textAlign: 'center' }}>
                <p style={{
                  fontSize: '14px',
                  fontWeight: 500,
                  color: 'var(--text)',
                  marginBottom: '4px',
                }}>
                  Drop your JSON file here
                </p>
                <p style={{
                  fontSize: '13px',
                  color: 'var(--text-secondary)',
                }}>
                  or click to browse
                </p>
              </div>
              <p style={{
                fontSize: '11px',
                color: 'var(--text-muted)',
              }}>
                Accepts .json files · array or single object
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleFileInput}
                style={{ display: 'none' }}
              />
            </div>
          ) : (
            <div>
              {/* File loaded state */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 16px',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                marginBottom: '12px',
              }}>
                <FileJson size={18} style={{
                  color: parseResult.error
                    ? '#DC2626' : '#16A34A',
                  flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    fontSize: '13px',
                    fontWeight: 500,
                    color: 'var(--text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {fileName}
                  </p>
                  <p style={{
                    fontSize: '12px',
                    color: parseResult.error
                      ? '#DC2626' : '#16A34A',
                  }}>
                    {parseResult.error
                      ? parseResult.error
                      : `${parseResult.records.length} record${parseResult.records.length !== 1 ? 's' : ''} ready to upload`}
                  </p>
                </div>
                <button
                  onClick={clearFile}
                  style={{
                    color: 'var(--text-muted)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    padding: '4px',
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {/* Preview — first record */}
              {!parseResult.error &&
                parseResult.records.length > 0 && (
                <div>
                  <p style={{
                    fontSize: '11px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    marginBottom: '8px',
                  }}>
                    Preview — first record
                  </p>
                  <div style={{
                    backgroundColor: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    padding: '12px',
                    maxHeight: '200px',
                    overflowY: 'auto',
                  }}>
                    <pre style={{
                      fontSize: '11px',
                      color: 'var(--text-secondary)',
                      fontFamily: 'monospace',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      margin: 0,
                    }}>
                      {JSON.stringify(
                        parseResult.records[0],
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                  {parseResult.records.length > 1 && (
                    <p style={{
                      fontSize: '12px',
                      color: 'var(--text-muted)',
                      marginTop: '8px',
                    }}>
                      + {parseResult.records.length - 1} more record{parseResult.records.length - 1 !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Upload error */}
          {uploadError && (
            <div style={{
              display: 'flex',
              gap: '8px',
              padding: '10px 14px',
              backgroundColor: '#FEF2F2',
              borderRadius: '8px',
              alignItems: 'flex-start',
            }}>
              <AlertCircle size={14} style={{
                color: '#DC2626',
                flexShrink: 0,
                marginTop: '1px',
              }} />
              <p style={{
                fontSize: '13px',
                color: '#DC2626',
              }}>
                {uploadError}
              </p>
            </div>
          )}

          {/* Success */}
          {uploadSuccess && (
            <div style={{
              display: 'flex',
              gap: '8px',
              padding: '10px 14px',
              backgroundColor: '#F0FDF4',
              borderRadius: '8px',
              alignItems: 'center',
            }}>
              <CheckCircle2 size={14} style={{
                color: '#16A34A',
                flexShrink: 0,
              }} />
              <p style={{
                fontSize: '13px',
                color: '#16A34A',
                fontWeight: 500,
              }}>
                Records uploaded successfully
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {parseResult && !parseResult.error
              ? `${parseResult.records.length} records · ${module} module`
              : 'No file selected'}
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              icon={<Upload size={14} />}
              loading={upload.isPending}
              disabled={
                !parseResult ||
                !!parseResult.error ||
                parseResult.records.length === 0 ||
                uploadSuccess
              }
              onClick={handleSubmit}
            >
              Upload {parseResult && !parseResult.error
                ? `${parseResult.records.length} record${parseResult.records.length !== 1 ? 's' : ''}`
                : 'records'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
