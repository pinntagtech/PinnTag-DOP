import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  PlayCircle,
  ShieldAlert,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { AdminPasswordModal } from "../components/sessions/AdminPasswordModal";
import { VirtualDiffList } from "../components/sync/VirtualDiffList";
import {
  useSyncApply,
  useSyncPreview,
  useSyncRuns,
  type ApplyReport,
  type PreviewReport,
  type SyncDiff,
  type SyncEnvironment,
} from "../hooks/use-db-sync";

const ENVS: SyncEnvironment[] = ["staging", "pre-prod", "production"];

const OUTCOME_COLOR: Record<SyncDiff["outcome"], string> = {
  patched: "var(--green)",
  skipped: "var(--text-muted)",
  failed: "var(--red)",
  assertion_failed: "var(--amber)",
  missing: "var(--red)",
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
        background: "var(--surface-elevated)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "8px 12px",
        minWidth: "110px",
      }}
    >
      <div
        style={{
          fontSize: "10px",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "18px",
          fontWeight: 700,
          color: tone ?? "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function DiffRow({
  d,
  open,
  onToggle,
}: {
  d: SyncDiff;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
      }}
    >
      <button
        onClick={onToggle}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "var(--text)",
          fontSize: "12px",
          textAlign: "left",
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            color: "var(--text-secondary)",
            flex: "0 0 220px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {d.businessId}
        </span>
        <span
          style={{
            fontSize: "11px",
            fontWeight: 600,
            color: OUTCOME_COLOR[d.outcome],
            flex: "0 0 130px",
          }}
        >
          {d.outcome}
        </span>
        <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
          {d.changedFields.length} field
          {d.changedFields.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div
          style={{
            padding: "8px 16px 12px 32px",
            fontSize: "11px",
            color: "var(--text-secondary)",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          {d.error && (
            <div style={{ color: "var(--red)" }}>error: {d.error}</div>
          )}
          {d.changedFields.length > 0 && (
            <div>
              <span style={{ color: "var(--text-muted)" }}>
                changedFields:{" "}
              </span>
              {d.changedFields.join(", ")}
            </div>
          )}
          {d.walletMissing && <div>creditWallet: will be created</div>}
          {d.linkMissing && <div>appRedirectLink: will be minted</div>}
          {d.outletPatches && d.outletPatches.length > 0 && (
            <div>
              {d.outletPatches.length} outlet patch(es):{" "}
              {d.outletPatches
                .map(
                  (op) =>
                    `${op.outletId.slice(-6)}(${op.changedFields.length})`,
                )
                .join(", ")}
            </div>
          )}
          {d.arrayRepair && (
            <div>
              array repair: {Object.keys(d.arrayRepair).join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiffTable({ diffs }: { diffs: SyncDiff[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const visible = diffs.filter((d) => d.outcome !== "skipped");
  if (visible.length === 0) {
    return (
      <p
        style={{
          fontSize: "12px",
          color: "var(--text-muted)",
          padding: "8px 0",
        }}
      >
        Nothing to patch — every business in scope is already synced.
      </p>
    );
  }
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };
  return (
    <VirtualDiffList
      title="Businesses to patch"
      count={visible.length}
      rows={visible}
      estimateRowHeight={40}
      renderRow={(d) => (
        <DiffRow
          d={d}
          open={expanded.has(d.businessId)}
          onToggle={() => toggle(d.businessId)}
        />
      )}
    />
  );
}

function ApplyResultsTable({ report }: { report: ApplyReport }) {
  const byOutcome = report.results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const failures = report.results.filter(
    (r) => r.outcome === "failed" || r.outcome === "assertion_failed",
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <StatPill
          label="patched"
          value={report.totals.patched}
          tone="var(--green)"
        />
        <StatPill
          label="failed"
          value={report.totals.failed}
          tone="var(--red)"
        />
        <StatPill label="already synced" value={byOutcome["skipped"] ?? 0} />
        <StatPill
          label="assertion failed"
          value={byOutcome["assertion_failed"] ?? 0}
          tone="var(--amber)"
        />
        <StatPill
          label="missing"
          value={byOutcome["missing"] ?? 0}
          tone="var(--red)"
        />
        <StatPill
          label="coverage gap"
          value={report.totals.coverageGap}
          tone={report.totals.coverageGap > 0 ? "var(--amber)" : undefined}
        />
      </div>
      {failures.length > 0 && (
        <VirtualDiffList
          title="Failures & assertion failures"
          count={failures.length}
          rows={failures}
          estimateRowHeight={28}
          maxHeightVh={30}
          renderRow={(f) => (
            <div
              style={{
                fontSize: "11px",
                color: "var(--text-secondary)",
                padding: "6px 12px",
                borderBottom: "1px solid var(--border)",
                background: "var(--surface)",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {f.businessId}
              </span>
              {" — "}
              <span
                style={{ color: OUTCOME_COLOR[f.outcome], fontWeight: 600 }}
              >
                {f.outcome}
              </span>
              {f.error && (
                <span style={{ color: "var(--red)", marginLeft: "6px" }}>
                  : {f.error}
                </span>
              )}
            </div>
          )}
        />
      )}
    </div>
  );
}

function EnvironmentSection({ environment }: { environment: SyncEnvironment }) {
  const isProd = environment === "production";
  const [preview, setPreview] = useState<PreviewReport | null>(null);
  const [apply, setApply] = useState<ApplyReport | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [prodConfirmed, setProdConfirmed] = useState(false);

  const previewMutation = useSyncPreview();
  const applyMutation = useSyncApply();

  const runPreview = async () => {
    setApply(null);
    const data = await previewMutation.mutateAsync({ environment });
    setPreview(data);
  };

  const runApply = async (adminPassword?: string) => {
    const data = await applyMutation.mutateAsync({
      environment,
      adminPassword,
    });
    setApply(data);
    setPreview(null);
    setProdConfirmed(false);
    setShowAdmin(false);
  };

  const onApplyClick = () => {
    if (!isProd) {
      runApply();
      return;
    }
    setShowAdmin(true);
  };

  const applyDisabled =
    !preview ||
    (preview.totals.toPatch === 0 && !preview.totals.missingInTarget);

  return (
    <Card className="flex flex-col gap-4">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Database size={16} color={isProd ? "var(--red)" : "var(--accent)"} />
          <h2
            style={{
              fontSize: "14px",
              fontWeight: 600,
              color: "var(--text)",
              textTransform: "capitalize",
            }}
          >
            {environment}
          </h2>
          {isProd && (
            <span
              style={{
                fontSize: "10px",
                color: "var(--red)",
                fontWeight: 700,
                background: "rgba(239, 68, 68, 0.08)",
                padding: "2px 6px",
                borderRadius: "4px",
              }}
            >
              PRODUCTION
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <Button
            variant="secondary"
            onClick={runPreview}
            loading={previewMutation.isPending}
          >
            <PlayCircle size={13} style={{ marginRight: "6px" }} /> Preview
          </Button>
          <Button
            variant={isProd ? "danger" : "primary"}
            disabled={applyDisabled || applyMutation.isPending}
            onClick={onApplyClick}
            loading={applyMutation.isPending}
          >
            <CheckCircle2 size={13} style={{ marginRight: "6px" }} /> Apply
          </Button>
        </div>
      </div>

      {previewMutation.isError && (
        <p style={{ fontSize: "12px", color: "var(--red)" }}>
          Preview failed: {(previewMutation.error as Error).message}
        </p>
      )}
      {applyMutation.isError && (
        <p style={{ fontSize: "12px", color: "var(--red)" }}>
          Apply failed: {(applyMutation.error as Error).message}
        </p>
      )}

      {preview && (
        <>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <StatPill label="targeted" value={preview.totals.targeted} />
            <StatPill
              label="to patch"
              value={preview.totals.toPatch}
              tone={preview.totals.toPatch > 0 ? "var(--accent)" : undefined}
            />
            <StatPill
              label="already synced"
              value={preview.totals.alreadySynced}
            />
            <StatPill
              label="assertion failed"
              value={preview.totals.assertionFailed}
              tone={
                preview.totals.assertionFailed > 0 ? "var(--amber)" : undefined
              }
            />
            <StatPill
              label="missing in target"
              value={preview.totals.missingInTarget}
              tone={
                preview.totals.missingInTarget > 0 ? "var(--red)" : undefined
              }
            />
            <StatPill
              label="coverage gap"
              value={preview.totals.coverageGap}
              tone={preview.totals.coverageGap > 0 ? "var(--amber)" : undefined}
            />
          </div>

          {preview.totals.coverageGap > 0 && (
            <div
              style={{
                display: "flex",
                gap: "8px",
                padding: "10px 14px",
                border: "1px solid var(--amber)",
                background: "rgba(245, 158, 11, 0.08)",
                borderRadius: "var(--radius)",
                color: "var(--amber)",
                fontSize: "12px",
              }}
            >
              <AlertTriangle
                size={14}
                style={{ flexShrink: 0, marginTop: "2px" }}
              />
              <div>
                Coverage gap of <b>{preview.totals.coverageGap}</b> — target DB
                has more <code>isFromCrawler || isCvb</code> businesses than DOP
                knows about. These are NOT auto-patched; investigate the missing
                DOP records.
              </div>
            </div>
          )}

          <DiffTable diffs={preview.diffs} />
        </>
      )}

      {apply && (
        <>
          <h3
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--text-muted)",
            }}
          >
            Apply report
          </h3>
          <ApplyResultsTable report={apply} />
        </>
      )}

      {showAdmin && (
        <AdminPasswordModal
          title="Confirm production sync"
          warning={
            prodConfirmed
              ? "Enter the DOP admin password to apply the patch to PRODUCTION businesses."
              : "You are about to WRITE TO PRODUCTION. Confirm the explicit checkbox first, then enter the admin password."
          }
          confirmLabel="Apply to production"
          confirmVariant="danger"
          loading={applyMutation.isPending}
          onClose={() => {
            setShowAdmin(false);
            setProdConfirmed(false);
          }}
          onConfirm={(password) => {
            if (!prodConfirmed) {
              return;
            }
            runApply(password);
          }}
        />
      )}

      {showAdmin && (
        <div
          style={{
            position: "fixed",
            bottom: "32px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--surface-elevated)",
            border: "1px solid var(--border)",
            padding: "10px 14px",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-lg)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            zIndex: 60,
          }}
        >
          <ShieldAlert size={14} color="var(--red)" />
          <label
            style={{
              fontSize: "12px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              cursor: "pointer",
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

export default function DbSyncPage() {
  const { data: runs } = useSyncRuns();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <header>
        <h1
          style={{
            fontSize: "20px",
            fontWeight: 600,
            color: "var(--text)",
            margin: 0,
          }}
        >
          DB Sync
        </h1>
        <p
          style={{
            fontSize: "13px",
            color: "var(--text-secondary)",
            marginTop: "4px",
          }}
        >
          Reconciles seeded businesses against the parity contract. Preview is
          read-only; Apply writes only set-if-missing fields to the DOP-internal{" "}
          <code>publishedId</code> scope.
        </p>
      </header>

      {ENVS.map((env) => (
        <EnvironmentSection key={env} environment={env} />
      ))}

      <Card>
        <h2
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--text)",
            marginBottom: "12px",
          }}
        >
          Recent runs
        </h2>
        {!runs || runs.length === 0 ? (
          <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            No sync runs yet.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {runs.slice(0, 20).map((r) => (
              <div
                key={r._id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "8px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  fontSize: "12px",
                  color: "var(--text-secondary)",
                }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    color: "var(--text)",
                    textTransform: "capitalize",
                    minWidth: "90px",
                  }}
                >
                  {r.environment}
                </span>
                <span style={{ minWidth: "90px" }}>{r.status}</span>
                <span style={{ minWidth: "160px" }}>
                  {new Date(r.createdAt).toLocaleString()}
                </span>
                <span>
                  by {r.startedBy} — patched {r.totals.patched ?? 0}, failed{" "}
                  {r.totals.failed ?? 0}, skipped {r.totals.alreadySynced ?? 0}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
