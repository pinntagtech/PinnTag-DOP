import { Fragment, useRef, useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowLeft,
  Play,
  Wand2,
  Sparkles,
  Star,
  CheckCircle2,
  Send,
  ChevronRight,
  AlertCircle,
  AlertTriangle,
  Upload,
  RefreshCw,
  MoreHorizontal,
  Images,
  ArrowRightLeft,
  CheckCircle,
  Zap,
  Image as ImageIcon,
} from "lucide-react";
import {
  useSession,
  useSessionLogs,
  usePipelineAction,
  useResetSession,
  useDeleteSession,
  useTriggerBotScrape,
  useResetBotStages,
  useCvbValidate,
  useCvbAutoFix,
  useAssignCoverAsLogo,
  useSessionBotJobs,
  useActiveSessionJobs,
} from "../hooks/use-sessions";
import {
  recordKeys,
  useSessionRecords,
  useReEnrich,
} from "../hooks/use-records";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { PipelineStrip } from "../components/ui/PipelineStrip";
import { Skeleton } from "../components/ui/Skeleton";
import { RecordDetailPanel } from "../components/sessions/RecordDetailPanel";
import { BotProgressCompact } from "../components/ui/BotProgressBar";
import { UploadRecordsModal } from "../components/sessions/UploadRecordsModal";
import { AdminPasswordModal } from "../components/sessions/AdminPasswordModal";
import { MigrationModal } from "../components/sessions/MigrationModal";
import { CvbImportPanel } from "../components/sessions/CvbImportPanel";
import type { SeedingRecord, SeedingLog } from "@pinntag-dop/types";

const EMPTY_STATS = {
  raw: 0,
  validated: 0,
  transformed: 0,
  enriched: 0,
  ready: 0,
  published: 0,
  failed: 0,
  skipped: 0,
};

// Which pipeline actions are available per status
const PIPELINE_ACTIONS: Record<
  string,
  {
    action: string;
    label: string;
    icon: React.ReactNode;
    variant: "primary" | "secondary" | "danger";
  }[]
> = {
  draft: [
    {
      action: "validate",
      label: "Run validation",
      icon: <Play size={14} />,
      variant: "primary",
    },
  ],
  validated: [
    {
      action: "transform",
      label: "Run transformation",
      icon: <Wand2 size={14} />,
      variant: "primary",
    },
  ],
  transformed: [
    {
      action: "enrich",
      label: "Run enrichment",
      icon: <Sparkles size={14} />,
      variant: "primary",
    },
  ],
  enriched: [
    {
      action: "approve",
      label: "Approve for publishing",
      icon: <CheckCircle2 size={14} />,
      variant: "primary",
    },
  ],
  ready: [
    {
      action: "publish",
      label: "Publish",
      icon: <Send size={14} />,
      variant: "primary",
    },
  ],
};

const LOG_DOT: Record<string, string> = {
  created: "#16A34A",
  approved: "#16A34A",
  published: "#16A34A",
  validated: "#16A34A",
  failed: "#DC2626",
  validation_failed: "#DC2626",
  publish_failed: "#DC2626",
  status_changed: "#1A6BFF",
  enriched: "#D97706",
  transformed: "#D97706",
};

type Tab = "records" | "logs" | "cvb";

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>("records");
  const [selectedRecord, setSelectedRecord] = useState<SeedingRecord | null>(
    null,
  );
  const [showUpload, setShowUpload] = useState(false);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [showAdminMenu, setShowAdminMenu] = useState(false);
  const [adminModal, setAdminModal] = useState<"reset" | "delete" | null>(null);
  const [showReviewsModal, setShowReviewsModal] = useState(false);
  const [showGalleryModal, setShowGalleryModal] = useState(false);
  const [showMigrateModal, setShowMigrateModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [botToast, setBotToast] = useState<string | null>(null);
  const [cvbTotal, setCvbTotal] = useState<number | null>(null);

  const queryClient = useQueryClient();
  const { data: session, isLoading: sessionLoading } = useSession(id ?? "");
  // Bot jobs query feeds jobsActive — must be initialised before
  // useSessionRecords so its polling interval can gate on activity.
  const { data: botJobs } = useSessionBotJobs(id ?? "");
  const jobsActive =
    (botJobs?.total?.pending ?? 0) + (botJobs?.total?.running ?? 0) > 0;
  const {
    data: records,
    isLoading: recordsLoading,
    refetch: refetchRecords,
  } = useSessionRecords(id ?? "", {}, { jobsActive });
  const { data: logs } = useSessionLogs(id ?? "");
  const pipelineAction = usePipelineAction(id ?? "");
  const reEnrich = useReEnrich(id ?? "");
  const resetSession = useResetSession();
  const deleteSession = useDeleteSession();
  const triggerBot = useTriggerBotScrape();
  const resetBotStages = useResetBotStages();
  const cvbValidate = useCvbValidate();
  const cvbAutoFix = useCvbAutoFix();
  const assignCoverAsLogo = useAssignCoverAsLogo();
  const { data: activeBotJobs } = useActiveSessionJobs(id ?? "");
  const [showActiveJobs, setShowActiveJobs] = useState(false);

  // When bot jobs transition from running → idle, do ONE extra refetch
  // so the final webhook write (cover/logo mirror) lands in the table
  // without leaving any background interval in place.
  const wasJobsActive = useRef(jobsActive);
  useEffect(() => {
    if (wasJobsActive.current && !jobsActive && id) {
      queryClient.invalidateQueries({ queryKey: recordKeys.session(id, {}) });
    }
    wasJobsActive.current = jobsActive;
  }, [jobsActive, id, queryClient]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const botEligibleRecords = (records ?? []).filter(
    (r) =>
      r.transformedData?.placeId &&
      ((r.status === "published" && r.publishedId) ||
        (r.cvbBusinessId && session?.type === "cvb")),
  );

  const botRecords = botEligibleRecords
    .map((r) => ({
      placeId: String(r.transformedData!.placeId),
      businessId: r.cvbBusinessId || r.publishedId!,
      businessName: String(r.transformedData?.name ?? ""),
      environment: session?.environment ?? "staging",
      maxReviews: r.transformedData?.userRatingCount
        ? Math.min(r.transformedData.userRatingCount, 500)
        : 100,
    }))
    .filter((r) => r.placeId && r.businessId);

  const handleResetBotStage = async (stage: "gallery" | "menu" | "reviews") => {
    if (!id) return;
    const label =
      stage === "gallery" ? "gallery" : stage === "menu" ? "menu" : "review";
    const confirmed = window.confirm(
      `This will delete all ${label} data for published ` +
        `businesses in this session from the target DB.`,
    );
    if (!confirmed) return;
    try {
      await resetBotStages.mutateAsync({
        sessionId: id,
        stages: [stage],
        environment: session?.environment ?? "dev",
      });
      const nice =
        stage === "gallery" ? "Gallery" : stage === "menu" ? "Menu" : "Reviews";
      setBotToast(
        `${nice} data reset. You can now re-fetch using the ` + `button above.`,
      );
      setTimeout(() => setBotToast(null), 5000);
    } catch (err: any) {
      alert(err?.response?.data?.message ?? err.message ?? "Reset failed");
    }
  };

  const handleGalleryConfirm = async () => {
    if (!id || botRecords.length === 0) return;
    try {
      await triggerBot.mutateAsync({
        sessionId: id,
        records: botRecords,
        skipReviews: true,
        skipGallery: false,
        skipMenu: false,
      });
      setShowGalleryModal(false);
      setBotToast(
        `Gallery & menu scraping started for ` +
          `${botRecords.length} businesses. ` +
          `Photos will appear in drives within a few minutes.`,
      );
      setTimeout(() => setBotToast(null), 5000);
    } catch (err: any) {
      alert(
        err?.response?.data?.message ?? err.message ?? "Gallery fetch failed",
      );
    }
  };

  const handleReviewsConfirm = async () => {
    if (!id || botEligibleRecords.length === 0) return;
    try {
      await triggerBot.mutateAsync({
        sessionId: id,
        records: botEligibleRecords
          .map((r) => ({
            placeId: String(r.transformedData!.placeId),
            businessId: r.cvbBusinessId || r.publishedId!,
            businessName: String(r.transformedData?.name ?? ""),
            environment: session?.environment ?? "staging",
            maxReviews: r.transformedData?.userRatingCount
              ? Math.min(r.transformedData.userRatingCount, 500)
              : 100,
          }))
          .filter((r) => r.placeId && r.businessId),
        skipReviews: false,
        skipGallery: true,
        skipMenu: true,
      });
      setShowReviewsModal(false);
      setToast(
        `Review fetching started for ${botEligibleRecords.length} businesses. ` +
          `Reviews will appear in the target DB within a few minutes.`,
      );
    } catch (err: any) {
      alert(
        err?.response?.data?.message ?? err.message ?? "Review fetch failed",
      );
    }
  };

  const toggleRecordSelection = (recordId: string) => {
    setSelectedRecordIds((prev) =>
      prev.includes(recordId)
        ? prev.filter((id) => id !== recordId)
        : [...prev, recordId],
    );
  };

  const toggleAllRecords = () => {
    if (!records) return;
    if (selectedRecordIds.length === records.length) {
      setSelectedRecordIds([]);
    } else {
      setSelectedRecordIds(records.map((r) => r._id));
    }
  };

  const handleReEnrich = async (recordIds: string[]) => {
    try {
      await reEnrich.mutateAsync(recordIds);
      setSelectedRecordIds([]);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCvbValidate = async () => {
    if (!id) return;
    try {
      const r = await cvbValidate.mutateAsync({
        sessionId: id,
      });
      setToast(
        `Validated ${r.total} records — ${r.withIssues} with issues, ` +
          `${r.clean} clean, ${r.autoFixable} auto-fixable.`,
      );
    } catch (err: any) {
      alert(err?.response?.data?.message ?? err.message ?? "Validation failed");
    }
  };

  const handleCvbAutoFix = async () => {
    if (!id) return;
    try {
      const r = await cvbAutoFix.mutateAsync({
        sessionId: id,
      });
      setToast(
        `Auto-fixed ${r.fixed} issues. ${r.skipped} require manual review.`,
      );
    } catch (err: any) {
      alert(err?.response?.data?.message ?? err.message ?? "Auto-fix failed");
    }
  };

  const handleAction = async (action: string) => {
    try {
      await pipelineAction.mutateAsync(action as any);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleAdminConfirm = async (password: string) => {
    try {
      if (adminModal === "reset") {
        await resetSession.mutateAsync({
          sessionId: id!,
          adminPassword: password,
        });
      } else if (adminModal === "delete") {
        await deleteSession.mutateAsync({
          sessionId: id!,
          adminPassword: password,
        });
      }
      setAdminModal(null);
      navigate("/sessions");
    } catch (err: any) {
      alert(err?.response?.data?.message ?? err.message ?? "Operation failed");
    }
  };

  if (sessionLoading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!session) {
    return (
      <div style={{ textAlign: "center", padding: "64px" }}>
        <p style={{ color: "var(--text-muted)", fontSize: "14px" }}>
          Session not found
        </p>
      </div>
    );
  }

  const availableActions = PIPELINE_ACTIONS[session.status] ?? [];
  const stats = session.stats ?? EMPTY_STATS;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Back + header */}
      <div>
        <button
          onClick={() => navigate("/sessions")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "13px",
            color: "var(--text-secondary)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "0",
            marginBottom: "12px",
          }}
        >
          <ArrowLeft size={14} />
          Back to sessions
        </button>

        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                marginBottom: "4px",
              }}
            >
              <h1
                style={{
                  fontSize: "20px",
                  fontWeight: 500,
                  color: "var(--text)",
                }}
              >
                {session.name}
              </h1>
              <Badge status={session.status} />
            </div>
            <p
              style={{
                fontSize: "13px",
                color: "var(--text-secondary)",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              <span>{session.sessionId}</span>
              <span>·</span>
              <span>by {session.createdBy}</span>
              <span>·</span>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 500,
                  padding: "2px 6px",
                  borderRadius: "4px",
                  backgroundColor:
                    session.environment === "production"
                      ? "#0A0A0A"
                      : session.environment === "staging"
                        ? "#7C3AED20"
                        : session.environment === "pre-prod"
                          ? "#04785720"
                          : "#2563EB20",
                  color:
                    session.environment === "production"
                      ? "#ffffff"
                      : session.environment === "staging"
                        ? "#7C3AED"
                        : session.environment === "pre-prod"
                          ? "#047857"
                          : "#2563EB",
                }}
              >
                {session.environment}
              </span>
              <span>·</span>
              <span>
                {formatDistanceToNow(new Date(session.createdAt), {
                  addSuffix: true,
                })}
              </span>
            </p>
          </div>

          {/* Pipeline action buttons */}
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {(session.status === "draft" || session.totalRecords === 0) && (
              <Button
                variant="secondary"
                icon={<Upload size={14} />}
                onClick={() => setShowUpload(true)}
              >
                Upload records
              </Button>
            )}
            {availableActions.map((a) => (
              <Button
                key={a.action}
                variant={a.variant}
                icon={a.icon}
                loading={pipelineAction.isPending}
                onClick={() => handleAction(a.action)}
              >
                {a.label}
              </Button>
            ))}

            {session.totalRecords > 0 && (
              <Button
                variant="secondary"
                icon={<Star size={14} />}
                loading={triggerBot.isPending}
                onClick={() => setShowReviewsModal(true)}
              >
                Fetch reviews
              </Button>
            )}

            {session.totalRecords > 0 && (
              <Button
                variant="secondary"
                icon={<Images size={14} />}
                onClick={() => setShowGalleryModal(true)}
              >
                Fetch gallery & menu
              </Button>
            )}

            {session.totalRecords > 0 && (
              <Button
                variant="secondary"
                icon={<ImageIcon size={14} />}
                loading={triggerBot.isPending}
                disabled={botRecords.length === 0}
                onClick={async () => {
                  if (!id || botRecords.length === 0) return;
                  try {
                    await triggerBot.mutateAsync({
                      sessionId: id,
                      records: botRecords,
                      skipReviews: true,
                      skipGallery: true,
                      skipMenu: true,
                      type: "image_sync",
                    });
                    setBotToast(
                      `Image sync started for ` +
                        `${botRecords.length} businesses`,
                    );
                    setTimeout(() => setBotToast(null), 5000);
                  } catch (err: any) {
                    alert(
                      err?.response?.data?.message ??
                        err.message ??
                        "Image sync failed",
                    );
                  }
                }}
              >
                Sync images
              </Button>
            )}

            {session.totalRecords > 0 && (
              <Button
                variant="secondary"
                icon={<ImageIcon size={14} />}
                loading={triggerBot.isPending}
                disabled={botRecords.length === 0 || triggerBot.isPending}
                onClick={() =>
                  triggerBot.mutateAsync({
                    sessionId: id!,
                    records: botRecords,
                    skipReviews: true,
                    skipGallery: true,
                    skipMenu: true,
                    type: "cover_sync",
                  })
                }
              >
                Fetch Cover
              </Button>
            )}

            {session.totalRecords > 0 && (
              <Button
                variant="secondary"
                icon={<ImageIcon size={14} />}
                loading={assignCoverAsLogo.isPending}
                onClick={async () => {
                  const result = await assignCoverAsLogo.mutateAsync({
                    sessionId: id!,
                    environment: session.environment,
                  });
                  setBotToast(result.message);
                  setTimeout(() => setBotToast(null), 5000);
                }}
              >
                {assignCoverAsLogo.isPending ? "Assigning..." : "Cover → Logo"}
              </Button>
            )}

            {session.status === "published" && session.type !== "migration" && (
              <Button
                variant="secondary"
                icon={<ArrowRightLeft size={14} />}
                onClick={() => setShowMigrateModal(true)}
              >
                Migrate
              </Button>
            )}

            {session.type === "cvb" && (
              <>
                <Button
                  variant="secondary"
                  icon={<CheckCircle size={14} />}
                  loading={cvbValidate.isPending}
                  onClick={handleCvbValidate}
                >
                  Validate all
                </Button>
                <Button
                  variant="secondary"
                  icon={<Zap size={14} />}
                  loading={cvbAutoFix.isPending}
                  onClick={handleCvbAutoFix}
                >
                  Auto-fix safe
                </Button>
              </>
            )}

            {/* Admin menu */}
            <div style={{ position: "relative" }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAdminMenu((v) => !v)}
              >
                <MoreHorizontal size={16} />
              </Button>
              {showAdminMenu && (
                <>
                  <div
                    style={{ position: "fixed", inset: 0, zIndex: 40 }}
                    onClick={() => setShowAdminMenu(false)}
                  />
                  <div
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "100%",
                      marginTop: "4px",
                      backgroundColor: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: "8px",
                      boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                      zIndex: 50,
                      minWidth: "180px",
                      overflow: "hidden",
                    }}
                  >
                    <button
                      onClick={() => {
                        setShowAdminMenu(false);
                        setAdminModal("reset");
                      }}
                      style={{
                        width: "100%",
                        padding: "10px 16px",
                        fontSize: "13px",
                        color: "var(--text)",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                      onMouseEnter={(e) =>
                        ((e.target as HTMLElement).style.backgroundColor =
                          "var(--surface-elevated)")
                      }
                      onMouseLeave={(e) =>
                        ((e.target as HTMLElement).style.backgroundColor =
                          "transparent")
                      }
                    >
                      Reset session
                    </button>
                    <button
                      onClick={() => {
                        setShowAdminMenu(false);
                        setAdminModal("delete");
                      }}
                      style={{
                        width: "100%",
                        padding: "10px 16px",
                        fontSize: "13px",
                        color: "#DC2626",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                      onMouseEnter={(e) =>
                        ((e.target as HTMLElement).style.backgroundColor =
                          "#FEF2F2")
                      }
                      onMouseLeave={(e) =>
                        ((e.target as HTMLElement).style.backgroundColor =
                          "transparent")
                      }
                    >
                      Delete session
                    </button>

                    <div
                      style={{
                        borderTop: "1px solid var(--border)",
                      }}
                    />

                    {(["gallery", "menu", "reviews"] as const).map((stage) => {
                      const label =
                        stage === "gallery"
                          ? "Reset gallery data"
                          : stage === "menu"
                            ? "Reset menu data"
                            : "Reset reviews";
                      return (
                        <button
                          key={stage}
                          onClick={() => {
                            setShowAdminMenu(false);
                            handleResetBotStage(stage);
                          }}
                          style={{
                            width: "100%",
                            padding: "10px 16px",
                            fontSize: "13px",
                            color: "var(--text)",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                          onMouseEnter={(e) =>
                            ((e.target as HTMLElement).style.backgroundColor =
                              "var(--surface-elevated)")
                          }
                          onMouseLeave={(e) =>
                            ((e.target as HTMLElement).style.backgroundColor =
                              "transparent")
                          }
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Bot processes strip */}
      {botJobs &&
        (() => {
          const types: {
            key: "cover_sync" | "gallery_menu" | "reviews" | "image_sync";
            label: string;
          }[] = [
            { key: "cover_sync", label: "Cover fetch" },
            { key: "gallery_menu", label: "Gallery & menu" },
            { key: "reviews", label: "Reviews" },
            { key: "image_sync", label: "Sync images" },
          ];

          const rows = types.map((t) => {
            const b = botJobs.byType?.[t.key] ?? {
              pending: 0,
              running: 0,
              done: 0,
              failed: 0,
            };
            return { ...t, ...b };
          });

          const totalActive =
            (botJobs.total?.pending ?? 0) + (botJobs.total?.running ?? 0);

          return (
            <div
              style={{
                border: "1px solid #E2E8F0",
                borderRadius: "8px",
                backgroundColor: "#F8FAFC",
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "#64748B",
                  }}
                >
                  Bot processes
                </span>
                {totalActive > 0 && (
                  <button
                    onClick={() => setShowActiveJobs((v) => !v)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#1D4ED8",
                      fontSize: "11px",
                      cursor: "pointer",
                      padding: "2px 6px",
                    }}
                  >
                    {showActiveJobs ? "Hide" : "Show"} {totalActive} active job
                    {totalActive === 1 ? "" : "s"}
                  </button>
                )}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "minmax(120px, 1fr) repeat(4, minmax(80px, auto))",
                  gap: "4px 12px",
                  fontSize: "12px",
                  fontVariantNumeric: "tabular-nums",
                  alignItems: "center",
                }}
              >
                {rows.map((r) => (
                  <Fragment key={r.key}>
                    <span style={{ color: "#0F172A", fontWeight: 500 }}>
                      {r.label}
                    </span>
                    <span
                      style={{ color: r.pending > 0 ? "#A16207" : "#94A3B8" }}
                    >
                      Pending: <strong>{r.pending}</strong>
                    </span>
                    <span
                      style={{ color: r.running > 0 ? "#1D4ED8" : "#94A3B8" }}
                    >
                      In process: <strong>{r.running}</strong>
                    </span>
                    <span style={{ color: r.done > 0 ? "#16A34A" : "#94A3B8" }}>
                      Done: <strong>{r.done}</strong>
                    </span>
                    <span
                      style={{
                        color: r.failed > 0 ? "#DC2626" : "#94A3B8",
                        visibility: r.failed > 0 ? "visible" : "hidden",
                      }}
                    >
                      Failed: <strong>{r.failed}</strong>
                    </span>
                  </Fragment>
                ))}
              </div>
            </div>
          );
        })()}

      {/* Active bot jobs list */}
      {showActiveJobs && activeBotJobs && activeBotJobs.length > 0 && (
        <div
          style={{
            border: "1px solid #E2E8F0",
            borderRadius: "8px",
            backgroundColor: "#ffffff",
            maxHeight: "240px",
            overflowY: "auto",
          }}
        >
          {activeBotJobs.map((j) => {
            const typeLabel: Record<string, string> = {
              gallery_menu: "Gallery/Menu",
              reviews: "Reviews",
              image_sync: "Images",
              cover_sync: "Cover",
            };
            return (
              <div
                key={`${j.businessId}-${j.type}-${j.createdAt}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 12px",
                  fontSize: "12px",
                  borderBottom: "1px solid #F1F5F9",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "#0F172A",
                  }}
                >
                  {j.businessName}
                </span>
                <span
                  style={{
                    fontSize: "11px",
                    padding: "1px 6px",
                    borderRadius: "4px",
                    backgroundColor: "#F1F5F9",
                    color: "#475569",
                  }}
                >
                  {typeLabel[j.type] ?? j.type}
                </span>
                <span
                  style={{
                    fontSize: "11px",
                    padding: "1px 6px",
                    borderRadius: "4px",
                    backgroundColor:
                      j.status === "running" ? "#DBEAFE" : "#FEF3C7",
                    color: j.status === "running" ? "#1D4ED8" : "#A16207",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    fontWeight: 600,
                  }}
                >
                  {j.status}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Pipeline strip */}
      <Card>
        <PipelineStrip stats={stats} />
      </Card>

      {/* Migration source banner */}
      {session.type === "migration" && session.migratedFrom && (
        <div
          style={{
            backgroundColor: "#F3F0FF",
            border: "1px solid #DDD6FE",
            borderRadius: "8px",
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            fontSize: "13px",
            color: "#5B21B6",
          }}
        >
          <ArrowRightLeft size={14} />
          <span>
            Migrated from <strong>{session.migratedFrom.sessionName}</strong> (
            {session.migratedFrom.environment}) on{" "}
            {new Date(session.migratedFrom.migratedAt).toLocaleDateString()}
          </span>
        </div>
      )}

      {/* Stats row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "12px",
        }}
      >
        {[
          { label: "Total records", value: session.totalRecords },
          { label: "Validated", value: stats.validated, color: "#16A34A" },
          {
            label: "Failed",
            value: stats.failed,
            color: stats.failed > 0 ? "#DC2626" : "var(--text-muted)",
          },
          { label: "Published", value: stats.published, color: "#1A6BFF" },
        ].map((stat) => (
          <div
            key={stat.label}
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              padding: "16px",
            }}
          >
            <p
              style={{
                fontSize: "11px",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--text-muted)",
                fontWeight: 500,
                marginBottom: "8px",
              }}
            >
              {stat.label}
            </p>
            <p
              style={{
                fontSize: "28px",
                fontWeight: 500,
                color: stat.color ?? "var(--text)",
                lineHeight: 1,
              }}
            >
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* Bot operations summary (only ops with lastRunAt) */}
      {(() => {
        const ops = session.botOperations;
        if (!ops) return null;
        const entries: {
          key: string;
          label: string;
          stat: {
            lastRunAt?: string | null;
            doneCount: number;
            failedCount: number;
          };
        }[] = [
          { key: "reviews", label: "Reviews", stat: ops.reviews as any },
          {
            key: "galleryMenu",
            label: "Gallery/Menu",
            stat: ops.galleryMenu as any,
          },
          { key: "imageSync", label: "Image sync", stat: ops.imageSync as any },
          { key: "coverSync", label: "Cover sync", stat: ops.coverSync as any },
        ].filter((e) => e.stat?.lastRunAt);
        if (entries.length === 0) return null;
        return (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
            {entries.map((e) => (
              <div
                key={e.key}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "12px",
                  padding: "6px 10px",
                  borderRadius: "6px",
                  backgroundColor: "var(--surface)",
                  border: "1px solid var(--border)",
                  color: "var(--text-secondary)",
                }}
              >
                <span style={{ fontWeight: 500, color: "var(--text)" }}>
                  {e.label}
                </span>
                <span style={{ color: "#16A34A" }}>
                  {e.stat.doneCount} done
                </span>
                {e.stat.failedCount > 0 && (
                  <>
                    <span style={{ color: "var(--text-muted)" }}>·</span>
                    <span style={{ color: "#DC2626" }}>
                      {e.stat.failedCount} failed
                    </span>
                  </>
                )}
                <span style={{ color: "var(--text-muted)" }}>·</span>
                <span>
                  {formatDistanceToNow(new Date(e.stat.lastRunAt as string), {
                    addSuffix: true,
                  })}
                </span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid var(--border)",
          gap: "4px",
          padding: "0 4px",
          background: "var(--surface)",
        }}
      >
        {(["records", "logs"] as Tab[]).map((tab) => {
          const active = activeTab === tab;
          const count =
            tab === "records"
              ? records?.length
              : tab === "logs"
                ? logs?.length
                : undefined;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                background: "transparent",
                border: "none",
                borderBottom: active
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
                color: active ? "var(--text)" : "var(--text-secondary)",
                fontWeight: active ? 600 : 400,
                padding: "10px 16px",
                fontSize: "13px",
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {tab}
              {count !== undefined && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minWidth: "18px",
                    height: "18px",
                    padding: "0 5px",
                    borderRadius: "999px",
                    fontSize: "10px",
                    fontWeight: 600,
                    marginLeft: "6px",
                    background: active
                      ? "var(--accent-subtle)"
                      : "var(--surface-elevated)",
                    color: active ? "var(--accent)" : "var(--text-muted)",
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
        {session.type === "cvb" &&
          (() => {
            const active = activeTab === "cvb";
            return (
              <button
                onClick={() => setActiveTab("cvb")}
                style={{
                  background: "transparent",
                  border: "none",
                  borderBottom: active
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
                  color: active ? "var(--text)" : "var(--text-secondary)",
                  fontWeight: active ? 600 : 400,
                  padding: "10px 16px",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                CVB Businesses
                {cvbTotal !== null && (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minWidth: "18px",
                      height: "18px",
                      padding: "0 5px",
                      borderRadius: "999px",
                      fontSize: "10px",
                      fontWeight: 600,
                      marginLeft: "6px",
                      background: active
                        ? "var(--accent-subtle)"
                        : "var(--surface-elevated)",
                      color: active ? "var(--accent)" : "var(--text-muted)",
                    }}
                  >
                    {cvbTotal.toLocaleString()}
                  </span>
                )}
              </button>
            );
          })()}
      </div>

      {/* Tab content */}
      {activeTab === "records" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: selectedRecord ? "1fr 420px" : "1fr",
            gap: "16px",
            alignItems: "start",
          }}
        >
          {/* Records table */}
          <div
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "10px",
              overflow: "hidden",
            }}
          >
            {/* Selection action bar */}
            {records &&
              records.length > 0 &&
              (selectedRecordIds.length > 0 ||
                session.status === "enriched") && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 16px",
                    backgroundColor: "var(--surface-elevated)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                    }}
                  >
                    {selectedRecordIds.length > 0 && (
                      <span
                        style={{
                          fontSize: "13px",
                          color: "var(--text)",
                          fontWeight: 500,
                        }}
                      >
                        {selectedRecordIds.length} selected
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    {selectedRecordIds.length > 0 && (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<RefreshCw size={12} />}
                        loading={reEnrich.isPending}
                        onClick={() => handleReEnrich(selectedRecordIds)}
                      >
                        Re-enrich selected
                      </Button>
                    )}
                    {session.status === "enriched" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<RefreshCw size={12} />}
                        loading={reEnrich.isPending}
                        onClick={() => handleReEnrich([])}
                      >
                        Re-enrich all
                      </Button>
                    )}
                  </div>
                </div>
              )}

            {recordsLoading ? (
              <div
                style={{
                  padding: "20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-14" />
                ))}
              </div>
            ) : !records || records.length === 0 ? (
              <div
                style={{
                  padding: "48px",
                  textAlign: "center",
                }}
              >
                <p
                  style={{
                    color: "var(--text-muted)",
                    fontSize: "14px",
                    marginBottom: "8px",
                  }}
                >
                  No records yet
                </p>
                <p style={{ color: "var(--text-muted)", fontSize: "13px" }}>
                  Upload JSON data to get started
                </p>
              </div>
            ) : (
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    {/* Checkbox header */}
                    <th
                      style={{
                        width: "44px",
                        padding: "12px 0 12px 16px",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={
                          records.length > 0 &&
                          selectedRecordIds.length === records.length
                        }
                        onChange={toggleAllRecords}
                        style={{ cursor: "pointer" }}
                      />
                    </th>
                    {[
                      "Module",
                      "Status",
                      "Validation",
                      "Published ID",
                      "Bot data",
                      "Updated",
                    ].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          fontSize: "11px",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          color: "var(--text-muted)",
                          fontWeight: 500,
                          padding: "12px 16px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                    <th style={{ width: "40px" }} />
                  </tr>
                </thead>
                <tbody>
                  {records.map((r: SeedingRecord) => {
                    const isSelected = selectedRecord?._id === r._id;
                    const isChecked = selectedRecordIds.includes(r._id);
                    const errorCount =
                      r.validationErrors?.filter((e) => e.severity === "error")
                        .length ?? 0;
                    const warnCount =
                      r.validationErrors?.filter(
                        (e) => e.severity === "warning",
                      ).length ?? 0;

                    return (
                      <tr
                        key={r._id}
                        onClick={() => setSelectedRecord(isSelected ? null : r)}
                        style={{
                          borderBottom: "1px solid var(--border)",
                          cursor: "pointer",
                          backgroundColor: isChecked
                            ? "#EFF6FF"
                            : isSelected
                              ? "var(--surface-elevated)"
                              : "transparent",
                          transition: "background-color 150ms",
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected && !isChecked)
                            (
                              e.currentTarget as HTMLElement
                            ).style.backgroundColor = "#FAFAFA";
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected && !isChecked)
                            (
                              e.currentTarget as HTMLElement
                            ).style.backgroundColor = "transparent";
                        }}
                      >
                        {/* Checkbox */}
                        <td
                          style={{
                            padding: "14px 0 14px 16px",
                            width: "44px",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              e.stopPropagation();
                              toggleRecordSelection(r._id);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: "pointer" }}
                          />
                        </td>

                        {/* Module */}
                        <td style={{ padding: "14px 16px" }}>
                          <span
                            style={{
                              fontSize: "12px",
                              fontWeight: 500,
                              color: "var(--text)",
                              backgroundColor: "var(--surface-elevated)",
                              padding: "2px 8px",
                              borderRadius: "4px",
                            }}
                          >
                            {r.module}
                          </span>
                        </td>

                        {/* Status */}
                        <td style={{ padding: "14px 16px" }}>
                          <Badge status={r.status} />
                        </td>

                        {/* Validation */}
                        <td style={{ padding: "14px 16px" }}>
                          <div
                            style={{
                              display: "flex",
                              gap: "8px",
                            }}
                          >
                            {errorCount > 0 && (
                              <span
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  fontSize: "12px",
                                  color: "#DC2626",
                                }}
                              >
                                <AlertCircle size={12} />
                                {errorCount} error{errorCount !== 1 ? "s" : ""}
                              </span>
                            )}
                            {warnCount > 0 && (
                              <span
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  fontSize: "12px",
                                  color: "#D97706",
                                }}
                              >
                                <AlertTriangle size={12} />
                                {warnCount} warning{warnCount !== 1 ? "s" : ""}
                              </span>
                            )}
                            {errorCount === 0 && warnCount === 0 && (
                              <span
                                style={{
                                  fontSize: "12px",
                                  color: "var(--text-muted)",
                                }}
                              >
                                —
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Published ID */}
                        <td style={{ padding: "14px 16px" }}>
                          {r.publishedId ? (
                            <span
                              style={{
                                fontFamily: "monospace",
                                fontSize: "11px",
                                color: "#16A34A",
                                backgroundColor: "#F0FDF4",
                                padding: "2px 6px",
                                borderRadius: "4px",
                              }}
                            >
                              {r.publishedId.slice(-8)}
                            </span>
                          ) : (
                            <span
                              style={{
                                fontSize: "12px",
                                color: "var(--text-muted)",
                              }}
                            >
                              —
                            </span>
                          )}
                        </td>

                        {/* Bot data */}
                        <td style={{ padding: "14px 16px", minWidth: "160px" }}>
                          <BotProgressCompact botScrape={r.botScrape} />
                        </td>

                        {/* Updated */}
                        <td
                          style={{
                            padding: "14px 16px",
                            fontSize: "12px",
                            color: "var(--text-muted)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {formatDistanceToNow(new Date(r.updatedAt), {
                            addSuffix: true,
                          })}
                        </td>

                        {/* Expand */}
                        <td style={{ padding: "14px 8px" }}>
                          <ChevronRight
                            size={14}
                            style={{
                              color: "var(--text-muted)",
                              transform: isSelected ? "rotate(90deg)" : "none",
                              transition: "transform 150ms",
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Record detail panel */}
          {selectedRecord && (
            <RecordDetailPanel
              record={selectedRecord}
              onClose={() => setSelectedRecord(null)}
            />
          )}
        </div>
      )}

      {/* Logs tab */}
      {activeTab === "logs" && (
        <div
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            overflow: "hidden",
          }}
        >
          {!logs || logs.length === 0 ? (
            <div style={{ padding: "48px", textAlign: "center" }}>
              <p style={{ color: "var(--text-muted)", fontSize: "14px" }}>
                No logs yet
              </p>
            </div>
          ) : (
            <div>
              {logs.map((log: SeedingLog, i) => (
                <div
                  key={log._id}
                  style={{
                    display: "flex",
                    gap: "14px",
                    padding: "14px 20px",
                    borderBottom:
                      i < logs.length - 1 ? "1px solid var(--border)" : "none",
                    alignItems: "flex-start",
                  }}
                >
                  {/* Dot */}
                  <div
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      backgroundColor: LOG_DOT[log.action] ?? "#A1A1AA",
                      marginTop: "5px",
                      flexShrink: 0,
                    }}
                  />

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        marginBottom: "2px",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "12px",
                          fontWeight: 500,
                          color: "var(--text)",
                        }}
                      >
                        {log.actor}
                      </span>
                      <span
                        style={{
                          fontSize: "11px",
                          color: "var(--text-muted)",
                          backgroundColor: "var(--surface-elevated)",
                          padding: "1px 6px",
                          borderRadius: "4px",
                          fontFamily: "monospace",
                        }}
                      >
                        {log.action}
                      </span>
                      {log.fromStatus && log.toStatus && (
                        <span
                          style={{
                            fontSize: "11px",
                            color: "var(--text-secondary)",
                          }}
                        >
                          {log.fromStatus} → {log.toStatus}
                        </span>
                      )}
                    </div>
                    {log.message && (
                      <p
                        style={{
                          fontSize: "13px",
                          color: "var(--text-secondary)",
                          lineHeight: 1.4,
                        }}
                      >
                        {log.message}
                      </p>
                    )}
                  </div>

                  {/* Timestamp */}
                  <span
                    style={{
                      fontSize: "11px",
                      color: "var(--text-muted)",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                      marginTop: "2px",
                    }}
                  >
                    {formatDistanceToNow(new Date(log.createdAt), {
                      addSuffix: true,
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* CVB tab */}
      {activeTab === "cvb" && session.type === "cvb" && (
        <CvbImportPanel
          sessionId={id!}
          environment={session.environment}
          onImported={() => refetchRecords()}
          onTotalLoaded={(t) => setCvbTotal(t)}
        />
      )}

      {/* Upload modal */}
      {showUpload && (
        <UploadRecordsModal
          sessionId={id ?? ""}
          onClose={() => setShowUpload(false)}
        />
      )}

      {/* Migration modal */}
      {showMigrateModal && id && (
        <MigrationModal
          sessionId={id}
          sessionName={session.name}
          sessionEnvironment={session.environment}
          publishedRecords={(records ?? []).filter(
            (r) => r.status === "published",
          )}
          onClose={() => setShowMigrateModal(false)}
        />
      )}

      {/* Admin password modals */}
      {adminModal === "reset" && (
        <AdminPasswordModal
          title="Reset session"
          warning="This will delete all published records from the target DB and reset this session to draft."
          confirmLabel="Reset session"
          confirmVariant="primary"
          loading={resetSession.isPending}
          onConfirm={handleAdminConfirm}
          onClose={() => setAdminModal(null)}
        />
      )}
      {adminModal === "delete" && (
        <AdminPasswordModal
          title="Delete session"
          warning="This will permanently delete this session, all records, and all published documents from the target DB. This cannot be undone."
          confirmLabel="Delete session"
          confirmVariant="danger"
          loading={deleteSession.isPending}
          onConfirm={handleAdminConfirm}
          onClose={() => setAdminModal(null)}
        />
      )}

      {/* Fetch reviews confirmation modal */}
      {showReviewsModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
          onClick={() => !triggerBot.isPending && setShowReviewsModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: "var(--surface)",
              borderRadius: "10px",
              padding: "24px",
              width: "460px",
              maxWidth: "90vw",
              boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
            }}
          >
            <h3
              style={{
                fontSize: "16px",
                fontWeight: 500,
                color: "var(--text)",
                marginBottom: "10px",
              }}
            >
              Fetch reviews
            </h3>
            <p
              style={{
                fontSize: "13px",
                color: "#52525B",
                lineHeight: 1.5,
                marginBottom: "12px",
              }}
            >
              This will scrape the latest Google Maps reviews for{" "}
              {botEligibleRecords.length} published businesses and save them to
              the target DB.
            </p>
            <div
              style={{
                fontSize: "12px",
                color: "#1E40AF",
                backgroundColor: "#EFF6FF",
                border: "1px solid #BFDBFE",
                borderRadius: "6px",
                padding: "8px 12px",
                marginBottom: "20px",
                lineHeight: 1.5,
              }}
            >
              Reviews are fetched manually so you can control when to refresh
              them.
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "8px",
              }}
            >
              <Button
                variant="secondary"
                onClick={() => setShowReviewsModal(false)}
                disabled={triggerBot.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={<Star size={14} />}
                loading={triggerBot.isPending}
                disabled={botEligibleRecords.length === 0}
                onClick={handleReviewsConfirm}
              >
                Fetch reviews for {botEligibleRecords.length} businesses
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Fetch gallery & menu confirmation modal */}
      {showGalleryModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
          onClick={() => !triggerBot.isPending && setShowGalleryModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: "var(--surface)",
              borderRadius: "10px",
              padding: "24px",
              width: "460px",
              maxWidth: "90vw",
              boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
            }}
          >
            <h3
              style={{
                fontSize: "16px",
                fontWeight: 500,
                color: "var(--text)",
                marginBottom: "10px",
              }}
            >
              Fetch gallery &amp; menu
            </h3>
            <p
              style={{
                fontSize: "13px",
                color: "#52525B",
                lineHeight: 1.5,
                marginBottom: "12px",
              }}
            >
              This will scrape Google Maps gallery photos (folder by folder) and
              menu highlights for {botEligibleRecords.length} published
              businesses.
            </p>
            <div
              style={{
                fontSize: "12px",
                color: "#1E40AF",
                backgroundColor: "#EFF6FF",
                border: "1px solid #BFDBFE",
                borderRadius: "6px",
                padding: "8px 12px",
                marginBottom: "20px",
                lineHeight: 1.5,
              }}
            >
              Gallery photos are saved to each business's drive folders. Menu
              items are saved to the menus collection.
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "8px",
              }}
            >
              <Button
                variant="secondary"
                onClick={() => setShowGalleryModal(false)}
                disabled={triggerBot.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={<Images size={14} />}
                loading={triggerBot.isPending}
                disabled={botEligibleRecords.length === 0}
                onClick={handleGalleryConfirm}
              >
                Fetch for {botEligibleRecords.length} businesses
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            backgroundColor: "#0A0A0A",
            color: "#ffffff",
            padding: "14px 20px",
            borderRadius: "8px",
            fontSize: "13px",
            maxWidth: "420px",
            lineHeight: 1.5,
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            zIndex: 200,
          }}
        >
          {toast}
        </div>
      )}

      {botToast && (
        <div
          style={{
            position: "fixed",
            bottom: toast ? "96px" : "24px",
            right: "24px",
            backgroundColor: "#0A0A0A",
            color: "#ffffff",
            padding: "14px 20px",
            borderRadius: "8px",
            fontSize: "13px",
            maxWidth: "420px",
            lineHeight: 1.5,
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            zIndex: 200,
          }}
        >
          {botToast}
        </div>
      )}
    </div>
  );
}
