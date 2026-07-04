import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Layers,
  PlayCircle,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { AdminPasswordModal } from '../components/sessions/AdminPasswordModal';
import {
  useGatedPreview,
  useBatchedGatedApply,
  type GatedPreviewReport,
  type GatedTargetEnv,
} from '../hooks/use-gated-migration';

const TARGET_ENVS: GatedTargetEnv[] = ['pre-prod', 'production'];

const REASON_LABELS: Record<string, string> = {
  valid_address: 'Address rejected (URL/phone/empty city)',
  singleton_placeId: 'Non-unique placeId (dupes drop all copies)',
  domestic_coords: 'Foreign or corrupt coordinates',
};

function StatPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div
      style={{
        background: 'var(--surface-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '8px 12px',
        minWidth: '110px',
      }}
    >
      <div
        style={{
          fontSize: '10px',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '18px',
          fontWeight: 700,
          color: tone ?? 'var(--text)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ExcludedByReasonChips({
  breakdown,
}: {
  breakdown: Record<string, number>;
}) {
  const entries = Object.entries(breakdown).filter(([, n]) => n > 0);
  if (!entries.length) {
    return (
      <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
        No JS-side gate exclusions on this run — everything the Mongo filter
        returned made it through.
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
      {entries.map(([reason, n]) => (
        <div
          key={reason}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 10px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            background: 'var(--surface-elevated)',
            fontSize: '12px',
            color: 'var(--text-secondary)',
          }}
        >
          <span style={{ color: 'var(--text-muted)' }}>
            {REASON_LABELS[reason] ?? reason}
          </span>
          <span
            style={{
              color: 'var(--text)',
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {n}
          </span>
        </div>
      ))}
    </div>
  );
}

function SampleList({
  sample,
}: {
  sample: GatedPreviewReport['sample'];
}) {
  const [open, setOpen] = useState(false);
  if (!sample.length) return null;
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-secondary)',
          fontSize: '12px',
          cursor: 'pointer',
          padding: '4px 0',
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Sample ({sample.length} eligible businesses shown)
      </button>
      {open && (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            background: 'var(--surface)',
            marginTop: '6px',
            maxHeight: '260px',
            overflowY: 'auto',
          }}
        >
          {sample.map((s) => (
            <div
              key={s.stagingId}
              style={{
                display: 'flex',
                gap: '12px',
                padding: '6px 12px',
                borderBottom: '1px solid var(--border)',
                fontSize: '11px',
                color: 'var(--text-secondary)',
              }}
            >
              <span
                style={{
                  color: 'var(--text)',
                  minWidth: '220px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.name || '(unnamed)'}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>
                {s.placeId}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-muted)',
                }}
              >
                {s.stagingId}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EnvironmentSection({
  environment,
}: {
  environment: GatedTargetEnv;
}) {
  const isProd = environment === 'production';
  const [preview, setPreview] = useState<GatedPreviewReport | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [prodConfirmed, setProdConfirmed] = useState(false);

  const previewMutation = useGatedPreview();
  const { run: runApplyLoop, progress, isRunning, reset } =
    useBatchedGatedApply();

  const runPreview = async () => {
    reset();
    const data = await previewMutation.mutateAsync({
      targetEnvironment: environment,
    });
    setPreview(data);
  };

  const runApply = async (adminPassword?: string) => {
    setPreview(null);
    setShowAdmin(false);
    setProdConfirmed(false);
    await runApplyLoop({
      targetEnvironment: environment,
      adminPassword,
      conflictMode: 'skip',
    });
  };

  const onApplyClick = () => {
    if (!isProd) {
      runApply();
      return;
    }
    setShowAdmin(true);
  };

  const applyDisabled =
    !preview || preview.willMigrate === 0 || isRunning;

  return (
    <Card className="flex flex-col gap-4">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Layers
            size={16}
            color={isProd ? 'var(--red)' : 'var(--accent)'}
          />
          <h2
            style={{
              fontSize: '14px',
              fontWeight: 600,
              color: 'var(--text)',
              textTransform: 'capitalize',
            }}
          >
            {environment}
          </h2>
          {isProd && (
            <span
              style={{
                fontSize: '10px',
                color: 'var(--red)',
                fontWeight: 700,
                background: 'rgba(239, 68, 68, 0.08)',
                padding: '2px 6px',
                borderRadius: '4px',
              }}
            >
              PRODUCTION
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            variant="secondary"
            onClick={runPreview}
            loading={previewMutation.isPending}
          >
            <PlayCircle size={13} style={{ marginRight: '6px' }} /> Preview
          </Button>
          <Button
            variant={isProd ? 'danger' : 'primary'}
            disabled={applyDisabled}
            onClick={onApplyClick}
            loading={isRunning}
          >
            <CheckCircle2 size={13} style={{ marginRight: '6px' }} /> Apply
          </Button>
        </div>
      </div>

      {previewMutation.isError && (
        <p style={{ fontSize: '12px', color: 'var(--red)' }}>
          Preview failed: {(previewMutation.error as Error).message}
        </p>
      )}

      {preview && (
        <>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <StatPill
              label="published total"
              value={preview.totals.publishedTotal}
            />
            <StatPill
              label="eligible"
              value={preview.totals.eligible}
              tone={
                preview.totals.eligible > 0 ? 'var(--accent)' : undefined
              }
            />
            <StatPill
              label="will migrate"
              value={preview.willMigrate}
              tone={preview.willMigrate > 0 ? 'var(--green)' : undefined}
            />
            <StatPill
              label="conflicts"
              value={preview.conflicts}
              tone={
                preview.conflicts > 0 ? 'var(--text-muted)' : undefined
              }
            />
            <StatPill label="excluded" value={preview.totals.excluded} />
          </div>

          {preview.willMigrate === 0 && (
            <p
              style={{
                fontSize: '12px',
                color: 'var(--text-muted)',
                padding: '4px 0',
              }}
            >
              Nothing eligible to migrate — either the quality gate excluded
              everything, or every eligible business is already present in{' '}
              {environment}.
            </p>
          )}

          <div>
            <h3
              style={{
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-muted)',
                marginBottom: '8px',
              }}
            >
              Excluded by reason
            </h3>
            <ExcludedByReasonChips
              breakdown={preview.totals.excludedByReason}
            />
          </div>

          <SampleList sample={preview.sample} />
        </>
      )}

      {progress && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            padding: '12px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            background: 'var(--surface-elevated)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
            }}
          >
            <h3
              style={{
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-muted)',
              }}
            >
              Batched apply
            </h3>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {progress.done ? 'complete' : 'running'} · batch{' '}
              {progress.batchNumber}
            </span>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <StatPill
              label="migrated"
              value={progress.totals.migrated}
              tone="var(--green)"
            />
            <StatPill
              label="conflicts skipped"
              value={progress.totals.conflictsSkipped}
            />
            <StatPill
              label="failed"
              value={progress.totals.failed}
              tone={
                progress.totals.failed > 0 ? 'var(--red)' : undefined
              }
            />
          </div>

          {progress.batches.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '3px',
                fontSize: '11px',
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {progress.batches.map((b, idx) => (
                <div key={idx}>
                  Batch {idx + 1}: migrated {b.totals.migrated}, skipped{' '}
                  {b.totals.conflictsSkipped}, failed {b.totals.failed} · session{' '}
                  {b.migrationSessionId.slice(-8)}
                </div>
              ))}
            </div>
          )}

          {progress.error && (
            <p
              style={{
                fontSize: '12px',
                color: 'var(--red)',
                padding: '8px',
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid var(--red)',
                borderRadius: 'var(--radius)',
              }}
            >
              {progress.error} — the gated apply is idempotent; run it again
              to resume from where it left off.
            </p>
          )}

          {progress.done && !progress.error && (
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Loop stopped after batch {progress.batchNumber} returned migrated:0.
              Migration sessions: {progress.migrationSessionIds.length}.
            </p>
          )}
        </div>
      )}

      {showAdmin && (
        <AdminPasswordModal
          title="Confirm production migration"
          warning={
            prodConfirmed
              ? 'Enter the DOP admin password to migrate the eligible businesses to PRODUCTION. Runs in batches of 500.'
              : 'You are about to WRITE TO PRODUCTION. Confirm the explicit checkbox first, then enter the admin password.'
          }
          confirmLabel="Apply to production"
          confirmVariant="danger"
          loading={isRunning}
          onClose={() => {
            setShowAdmin(false);
            setProdConfirmed(false);
          }}
          onConfirm={(password) => {
            if (!prodConfirmed) return;
            runApply(password);
          }}
        />
      )}

      {showAdmin && (
        <div
          style={{
            position: 'fixed',
            bottom: '32px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--surface-elevated)',
            border: '1px solid var(--border)',
            padding: '10px 14px',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-lg)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            zIndex: 60,
          }}
        >
          <ShieldAlert size={14} color="var(--red)" />
          <label
            style={{
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={prodConfirmed}
              onChange={(e) => setProdConfirmed(e.target.checked)}
            />
            I understand this writes to production
          </label>
        </div>
      )}
    </Card>
  );
}

export default function GatedMigrationPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <header>
        <h1
          style={{
            fontSize: '20px',
            fontWeight: 600,
            color: 'var(--text)',
            margin: 0,
          }}
        >
          Gated Migration
        </h1>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--text-secondary)',
            marginTop: '4px',
          }}
        >
          Migrate quality-gated businesses from staging to a target
          environment. Preview is read-only; Apply writes in batches of 500
          (re-running resumes safely).
        </p>
      </header>

      {TARGET_ENVS.map((env) => (
        <EnvironmentSection key={env} environment={env} />
      ))}
    </div>
  );
}
