import { useState } from 'react';
import { ChevronDown, Play } from 'lucide-react';
import { Button } from '../ui/Button';
import { AdminPasswordModal } from '../sessions/AdminPasswordModal';
import type {
  ConsoleActionType,
  ConsoleSelection,
} from '../../hooks/use-business-console';
import { useLaunchAction } from '../../hooks/use-business-console';

interface ActionDef {
  key: ConsoleActionType;
  label: string;
  needsAdminPassword: boolean;
  danger?: boolean;
  // ignoresSelection: true → the action operates on the whole seeded
  // corpus regardless of selection (gate/provenance recompute). Used to
  // keep the item enabled even when no rows are selected.
  ignoresSelection?: boolean;
}

// Order: destructive-adjacent priority actions first, bot triggers next,
// state flips, then whole-corpus recomputes. `create_missing_outlet` is
// deliberately absent — the audit (see Phase B API commit) found the
// backing helper copies the parent business's address onto the outlet,
// which is exactly the failure mode this console is meant to avoid.
// Every entry is a real, wired action; no "stage not shipped" stubs.
const ACTIONS: ActionDef[] = [
  { key: 'resync_city', label: 'Resync city from address', needsAdminPassword: true },
  // Rewrites the FULL Google formatted address currently in addressLine1
  // down to the street line only. Fixes the double-render ("…United
  // States, City, State") on the consumer app.
  { key: 'split_address_line', label: 'Split addressLine1 to street-only', needsAdminPassword: true },
  { key: 'dedup_place_id', label: 'Dedup by placeId', needsAdminPassword: true, danger: true },
  // Strips the pinntag-assets Defaults/* placeholder so Cover Backfill
  // discovery can queue the record for a real cover_sync. Never
  // modifies a real B2 cover; guarded per-doc in the pipeline.
  { key: 'strip_placeholder_covers', label: 'Strip placeholder covers', needsAdminPassword: true },
  { key: 'trigger_cover_sync', label: 'Trigger cover sync', needsAdminPassword: false },
  { key: 'trigger_image_sync', label: 'Trigger image sync', needsAdminPassword: false },
  { key: 'trigger_gallery_menu', label: 'Trigger gallery + menu', needsAdminPassword: false },
  { key: 'trigger_reviews', label: 'Trigger reviews scrape', needsAdminPassword: false },
  { key: 'trigger_email_scrape', label: 'Trigger email scrape (website)', needsAdminPassword: false },
  { key: 're_resolve', label: 'Re-resolve from Google', needsAdminPassword: false },
  { key: 'activate', label: 'Activate (isActive = true)', needsAdminPassword: true },
  { key: 'deactivate', label: 'Deactivate (isActive = false)', needsAdminPassword: true, danger: true },
  { key: 'gate_recompute', label: 'Recompute gate status (all seeded)', needsAdminPassword: false, ignoresSelection: true },
  { key: 'provenance_recompute', label: 'Recompute seed provenance (all seeded)', needsAdminPassword: false, ignoresSelection: true },
];

// dryRun is DEFAULT TRUE and must be flipped by the operator with an
// explicit toggle — never a hidden default. The toggle sits inline so
// the operator can't miss it right before hitting Action.
export function ActionMenu({
  environment,
  selection,
  onLaunched,
}: {
  environment: string;
  selection: ConsoleSelection | null;
  onLaunched: (runId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [pending, setPending] = useState<ActionDef | null>(null);
  const launch = useLaunchAction();

  const hasSelection =
    !!selection && !(selection.mode === 'ids' && selection.ids.length === 0);

  const run = async (action: ActionDef, adminPassword?: string) => {
    // ignoresSelection actions still need to send SOMETHING as the
    // selection payload; use an empty ids array so the server sees a
    // well-formed request. RunService.launchGateRecompute /
    // launchProvenanceRecompute both ignore the selection field.
    const effectiveSelection: ConsoleSelection =
      selection ?? { mode: 'ids', ids: [] };
    try {
      const { runId } = await launch.mutateAsync({
        environment,
        action: action.key,
        selection: effectiveSelection,
        dryRun,
        adminPassword,
      });
      setPending(null);
      setOpen(false);
      onLaunched(runId);
    } catch {
      // Error surfaces via launch.error below; keep the modal open so
      // the operator can retry with a corrected password.
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          fontSize: '11px',
          color: dryRun ? 'var(--text-secondary)' : 'var(--red, #ef4444)',
          fontWeight: dryRun ? 400 : 600,
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={dryRun}
          onChange={(e) => setDryRun(e.target.checked)}
        />
        {dryRun ? 'Dry run' : 'LIVE run — will write'}
      </label>

      <div style={{ position: 'relative' }}>
        <Button size="sm" variant="primary" onClick={() => setOpen((o) => !o)}>
          <Play size={12} style={{ marginRight: '4px' }} />
          Action
          <ChevronDown size={12} style={{ marginLeft: '4px' }} />
        </Button>
        {open && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              right: 0,
              background: 'var(--surface-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '4px',
              minWidth: '280px',
              zIndex: 40,
              boxShadow: 'var(--shadow-lg)',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
            }}
          >
            {ACTIONS.map((a) => {
              const disabled = !a.ignoresSelection && !hasSelection;
              return (
                <button
                  key={a.key}
                  disabled={disabled}
                  title={
                    disabled
                      ? 'Select rows or "select all matching" first'
                      : undefined
                  }
                  onClick={() => {
                    if (a.needsAdminPassword && !dryRun) {
                      setPending(a);
                    } else {
                      run(a);
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '7px 10px',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '12px',
                    color: disabled
                      ? 'var(--text-muted)'
                      : a.danger
                        ? 'var(--red, #ef4444)'
                        : 'var(--text)',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    textAlign: 'left',
                    opacity: disabled ? 0.6 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (!disabled) {
                      (e.currentTarget as HTMLElement).style.background =
                        'var(--surface)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background =
                      'transparent';
                  }}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {launch.isError && (
        <span style={{ fontSize: '11px', color: 'var(--red, #ef4444)' }}>
          {(launch.error as Error).message}
        </span>
      )}

      {pending && (
        <AdminPasswordModal
          title={`Confirm: ${pending.label}`}
          warning={
            `You are about to run ${pending.label} as a LIVE write against staging. ` +
            `Enter the DOP admin password to confirm. Dry-run is off.`
          }
          confirmLabel="Launch"
          confirmVariant={pending.danger ? 'danger' : 'primary'}
          loading={launch.isPending}
          onClose={() => setPending(null)}
          onConfirm={(password) => run(pending, password)}
        />
      )}
    </div>
  );
}
