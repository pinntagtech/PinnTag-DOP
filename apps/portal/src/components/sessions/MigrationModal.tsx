import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRightLeft } from 'lucide-react';
import { Button } from '../ui/Button';
import {
  useCheckMigration,
  useMigrateSession,
} from '../../hooks/use-sessions';
import type { SeedingRecord } from '@pinntag-dop/types';

type Env = 'dev' | 'pre-prod' | 'staging' | 'production';
type Step = 'select' | 'checking' | 'conflicts' | 'migrating' | 'done';

interface ConflictEntry {
  recordId: string;
  businessName: string;
  placeId: string;
  existingBusinessId: string;
}

interface CleanEntry {
  recordId: string;
  businessName: string;
  placeId: string;
}

interface MigrationModalProps {
  sessionId: string;
  sessionName: string;
  sessionEnvironment: Env;
  publishedRecords: SeedingRecord[];
  onClose: () => void;
}

export function MigrationModal({
  sessionId,
  sessionName,
  sessionEnvironment,
  publishedRecords,
  onClose,
}: MigrationModalProps) {
  const navigate = useNavigate();
  const checkMigration = useCheckMigration();
  const migrateSession = useMigrateSession();

  const availableTargets = useMemo(
    () =>
      (['dev', 'pre-prod', 'staging', 'production'] as Env[]).filter(
        (e) => e !== sessionEnvironment,
      ),
    [sessionEnvironment],
  );

  const [target, setTarget] = useState<Env>(
    availableTargets[0] ?? 'staging',
  );
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [recordIds, setRecordIds] = useState<string[]>([]);
  const [step, setStep] = useState<Step>('select');
  const [conflictData, setConflictData] = useState<{
    conflicts: ConflictEntry[];
    clean: CleanEntry[];
  } | null>(null);
  const [resolution, setResolution] = useState<
    Record<string, 'skip' | 'overwrite'>
  >({});
  const [migrationResult, setMigrationResult] = useState<{
    migrationSessionId: string;
  } | null>(null);

  const effectiveRecordIds =
    scope === 'selected' && recordIds.length > 0 ? recordIds : undefined;

  // Run conflict check on entering 'checking'
  useEffect(() => {
    if (step !== 'checking') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await checkMigration.mutateAsync({
          sessionId,
          targetEnvironment: target,
          recordIds: effectiveRecordIds,
        });
        if (cancelled) return;
        setConflictData(res);
        setStep('conflicts');
      } catch (err: any) {
        if (cancelled) return;
        alert(
          err?.response?.data?.message ??
            err.message ??
            'Conflict check failed',
        );
        setStep('select');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Run migration on entering 'migrating'
  useEffect(() => {
    if (step !== 'migrating') return;
    let cancelled = false;
    (async () => {
      try {
        // Default unset conflict resolutions to 'skip'
        const finalResolution: Record<string, 'skip' | 'overwrite'> = {};
        if (conflictData) {
          for (const c of conflictData.conflicts) {
            finalResolution[c.recordId] =
              resolution[c.recordId] ?? 'skip';
          }
        }
        const res = await migrateSession.mutateAsync({
          sessionId,
          targetEnvironment: target,
          recordIds: effectiveRecordIds,
          conflictResolution: finalResolution,
        });
        if (cancelled) return;
        setMigrationResult(res);
        setStep('done');
      } catch (err: any) {
        if (cancelled) return;
        alert(
          err?.response?.data?.message ??
            err.message ??
            'Migration failed',
        );
        setStep('conflicts');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const togglePublishedRecord = (rid: string) => {
    setRecordIds((prev) =>
      prev.includes(rid) ? prev.filter((x) => x !== rid) : [...prev, rid],
    );
  };

  const setConflictResolution = (
    rid: string,
    value: 'skip' | 'overwrite',
  ) => {
    setResolution((prev) => ({ ...prev, [rid]: value }));
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={() => {
        if (step === 'checking' || step === 'migrating') return;
        onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--surface)',
          borderRadius: '10px',
          padding: '24px',
          width: '560px',
          maxWidth: '90vw',
          maxHeight: '85vh',
          overflowY: 'auto',
          boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
        }}
      >
        {step === 'select' && (
          <SelectStep
            target={target}
            setTarget={setTarget}
            availableTargets={availableTargets}
            scope={scope}
            setScope={setScope}
            recordIds={recordIds}
            togglePublishedRecord={togglePublishedRecord}
            publishedRecords={publishedRecords}
            onCancel={onClose}
            onCheck={() => setStep('checking')}
            disableCheck={availableTargets.length === 0}
          />
        )}

        {step === 'checking' && (
          <div
            style={{
              padding: '40px 0',
              textAlign: 'center',
              fontSize: '14px',
              color: '#52525B',
            }}
          >
            <Spinner />
            <div style={{ marginTop: '14px' }}>
              Checking for conflicts in {target}...
            </div>
          </div>
        )}

        {step === 'conflicts' && conflictData && (
          <ConflictsStep
            conflictData={conflictData}
            target={target}
            resolution={resolution}
            setConflictResolution={setConflictResolution}
            onBack={() => setStep('select')}
            onStart={() => setStep('migrating')}
          />
        )}

        {step === 'migrating' && (
          <div style={{ padding: '40px 0', textAlign: 'center' }}>
            <Spinner />
            <h3
              style={{
                fontSize: '16px',
                fontWeight: 500,
                color: 'var(--text)',
                marginTop: '14px',
                marginBottom: '6px',
              }}
            >
              Migrating {sessionName} → {target}...
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              This may take a few minutes. Do not close this window.
            </p>
          </div>
        )}

        {step === 'done' && migrationResult && (
          <DoneStep
            target={target}
            migrationSessionId={migrationResult.migrationSessionId}
            onClose={() => {
              onClose();
              navigate('/sessions');
            }}
            onOpenSession={() => {
              onClose();
              navigate(
                `/sessions/${migrationResult.migrationSessionId}`,
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Step components ─────────────────────────────────────────────────────────

function SelectStep({
  target,
  setTarget,
  availableTargets,
  scope,
  setScope,
  recordIds,
  togglePublishedRecord,
  publishedRecords,
  onCancel,
  onCheck,
  disableCheck,
}: {
  target: 'dev' | 'pre-prod' | 'staging' | 'production';
  setTarget: (e: 'dev' | 'pre-prod' | 'staging' | 'production') => void;
  availableTargets: ('dev' | 'pre-prod' | 'staging' | 'production')[];
  scope: 'all' | 'selected';
  setScope: (s: 'all' | 'selected') => void;
  recordIds: string[];
  togglePublishedRecord: (rid: string) => void;
  publishedRecords: SeedingRecord[];
  onCancel: () => void;
  onCheck: () => void;
  disableCheck: boolean;
}) {
  return (
    <>
      <h3
        style={{
          fontSize: '16px',
          fontWeight: 500,
          color: 'var(--text)',
          marginBottom: '6px',
        }}
      >
        Migrate session
      </h3>
      <p
        style={{
          fontSize: '13px',
          color: 'var(--text-secondary)',
          marginBottom: '16px',
          lineHeight: 1.5,
        }}
      >
        Select target environment and which businesses to migrate.
      </p>

      <label
        style={{
          fontSize: '12px',
          fontWeight: 500,
          color: 'var(--text)',
          display: 'block',
          marginBottom: '6px',
        }}
      >
        Target environment
      </label>
      <select
        value={target}
        onChange={(e) =>
          setTarget(e.target.value as 'dev' | 'pre-prod' | 'staging' | 'production')
        }
        style={{
          padding: '8px 12px',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          fontSize: '13px',
          width: '100%',
          marginBottom: '16px',
        }}
      >
        {availableTargets.map((env) => (
          <option key={env} value={env}>
            {env}
          </option>
        ))}
      </select>

      <label
        style={{
          fontSize: '12px',
          fontWeight: 500,
          color: 'var(--text)',
          display: 'block',
          marginBottom: '8px',
        }}
      >
        Records to migrate
      </label>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          marginBottom: '14px',
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '13px',
            color: 'var(--text)',
            cursor: 'pointer',
          }}
        >
          <input
            type="radio"
            checked={scope === 'all'}
            onChange={() => setScope('all')}
          />
          All published businesses ({publishedRecords.length})
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '13px',
            color: 'var(--text)',
            cursor: 'pointer',
          }}
        >
          <input
            type="radio"
            checked={scope === 'selected'}
            onChange={() => setScope('selected')}
          />
          Selected businesses only
        </label>
      </div>

      {scope === 'selected' && (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: '6px',
            maxHeight: '200px',
            overflowY: 'auto',
            marginBottom: '16px',
            padding: '6px',
          }}
        >
          {publishedRecords.length === 0 ? (
            <p
              style={{
                fontSize: '12px',
                color: 'var(--text-muted)',
                padding: '12px',
                textAlign: 'center',
              }}
            >
              No published records
            </p>
          ) : (
            publishedRecords.map((r) => {
              const checked = recordIds.includes(r._id);
              const name =
                (r.transformedData?.name as string | undefined) ??
                r._id.slice(-8);
              return (
                <label
                  key={r._id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 8px',
                    fontSize: '13px',
                    color: 'var(--text)',
                    cursor: 'pointer',
                    borderRadius: '4px',
                    backgroundColor: checked ? '#EFF6FF' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => togglePublishedRecord(r._id)}
                  />
                  {name}
                </label>
              );
            })
          )}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px',
          marginTop: '8px',
        }}
      >
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon={<ArrowRightLeft size={14} />}
          disabled={disableCheck}
          onClick={onCheck}
        >
          Check for conflicts →
        </Button>
      </div>
    </>
  );
}

function ConflictsStep({
  conflictData,
  target,
  resolution,
  setConflictResolution,
  onBack,
  onStart,
}: {
  conflictData: {
    conflicts: ConflictEntry[];
    clean: CleanEntry[];
  };
  target: string;
  resolution: Record<string, 'skip' | 'overwrite'>;
  setConflictResolution: (
    rid: string,
    value: 'skip' | 'overwrite',
  ) => void;
  onBack: () => void;
  onStart: () => void;
}) {
  const hasConflicts = conflictData.conflicts.length > 0;

  return (
    <>
      <h3
        style={{
          fontSize: '16px',
          fontWeight: 500,
          color: 'var(--text)',
          marginBottom: '12px',
        }}
      >
        Review conflicts
      </h3>

      {!hasConflicts ? (
        <div
          style={{
            backgroundColor: '#F0FDF4',
            border: '1px solid #BBF7D0',
            borderRadius: '6px',
            padding: '12px',
            marginBottom: '16px',
            fontSize: '13px',
            color: '#15803D',
          }}
        >
          ✓ No conflicts found — {conflictData.clean.length} businesses
          ready to migrate
        </div>
      ) : (
        <>
          <div
            style={{
              backgroundColor: '#FFFBEB',
              border: '1px solid #FDE68A',
              borderRadius: '6px',
              padding: '12px',
              marginBottom: '12px',
              fontSize: '13px',
              color: '#92400E',
            }}
          >
            {conflictData.conflicts.length} businesses already exist in{' '}
            {target}
          </div>

          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: '6px',
              maxHeight: '260px',
              overflowY: 'auto',
              marginBottom: '12px',
            }}
          >
            {conflictData.conflicts.map((c) => {
              const choice = resolution[c.recordId] ?? 'skip';
              return (
                <div
                  key={c.recordId}
                  style={{
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--surface-elevated)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: '13px',
                        color: 'var(--text)',
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.businessName}
                    </div>
                    <div
                      style={{
                        fontSize: '11px',
                        fontFamily: 'monospace',
                        color: 'var(--text-muted)',
                        marginTop: '2px',
                      }}
                    >
                      {c.existingBusinessId.slice(-12)}
                    </div>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      gap: '0',
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      overflow: 'hidden',
                      flexShrink: 0,
                    }}
                  >
                    {(['skip', 'overwrite'] as const).map((opt) => {
                      const active = choice === opt;
                      return (
                        <button
                          key={opt}
                          onClick={() =>
                            setConflictResolution(c.recordId, opt)
                          }
                          style={{
                            padding: '4px 10px',
                            fontSize: '12px',
                            fontWeight: active ? 500 : 400,
                            backgroundColor: active
                              ? opt === 'overwrite'
                                ? '#DC2626'
                                : 'var(--text)'
                              : 'var(--surface)',
                            color: active ? 'var(--surface)' : 'var(--text-secondary)',
                            border: 'none',
                            cursor: 'pointer',
                            textTransform: 'capitalize',
                          }}
                        >
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              fontSize: '12px',
              color: '#15803D',
              marginBottom: '16px',
            }}
          >
            ✓ {conflictData.clean.length} businesses will be migrated
            without conflict
          </div>
        </>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px',
        }}
      >
        <Button variant="secondary" onClick={onBack}>
          {hasConflicts ? 'Back' : 'Cancel'}
        </Button>
        <Button
          variant="primary"
          icon={<ArrowRightLeft size={14} />}
          onClick={onStart}
        >
          Start migration →
        </Button>
      </div>
    </>
  );
}

function DoneStep({
  target,
  migrationSessionId,
  onClose,
  onOpenSession,
}: {
  target: string;
  migrationSessionId: string;
  onClose: () => void;
  onOpenSession: () => void;
}) {
  return (
    <>
      <h3
        style={{
          fontSize: '16px',
          fontWeight: 500,
          color: '#15803D',
          marginBottom: '10px',
        }}
      >
        Migration complete ✓
      </h3>
      <p
        style={{
          fontSize: '13px',
          color: '#52525B',
          lineHeight: 1.5,
          marginBottom: '6px',
        }}
      >
        Session successfully migrated to {target}.
      </p>
      <p
        style={{
          fontSize: '13px',
          color: '#52525B',
          lineHeight: 1.5,
          marginBottom: '14px',
        }}
      >
        A new migration session has been created.
      </p>

      <button
        onClick={onOpenSession}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '12px',
          fontFamily: 'monospace',
          fontWeight: 500,
          padding: '6px 10px',
          borderRadius: '6px',
          backgroundColor: '#F0FDF4',
          color: '#15803D',
          border: '1px solid #BBF7D0',
          cursor: 'pointer',
          marginBottom: '20px',
        }}
      >
        {migrationSessionId.slice(-12)}
      </button>

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px',
        }}
      >
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  );
}

function Spinner() {
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: '6px',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: '#7C3AED',
            opacity: 0.7,
            animation: `pulse 1.4s ${i * 0.2}s infinite ease-in-out`,
          }}
        />
      ))}
    </div>
  );
}
