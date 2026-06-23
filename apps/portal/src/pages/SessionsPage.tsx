import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import {
  Plus,
  Search,
  ChevronDown,
  Trash2,
  Download,
  MapPin,
  Tag,
} from "lucide-react";
import { useSessions, useDeleteSession } from "../hooks/use-sessions";
import { useEnvironment } from "../contexts/EnvironmentContext";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { CreateSessionModal } from "../components/sessions/CreateSessionModal";
import { ScraperImportModal } from "../components/sessions/ScraperImportModal";
import { AdminPasswordModal } from "../components/sessions/AdminPasswordModal";
import type { SeedingSession } from "@pinntag-dop/types";

const STATUS_OPTIONS = [
  "all",
  "draft",
  "validating",
  "validated",
  "transforming",
  "transformed",
  "enriching",
  "enriched",
  "ready",
  "publishing",
  "published",
  "failed",
  "cancelled",
];

const ENV_PILL: Record<string, { bg: string; text: string }> = {
  dev: { bg: "#F4F4F5", text: "#71717A" },
  "pre-prod": { bg: "#ECFDF5", text: "#047857" },
  staging: { bg: "#EFF6FF", text: "#1A6BFF" },
  production: { bg: "#FEF2F2", text: "#DC2626" },
};

export default function SessionsPage() {
  const navigate = useNavigate();
  const { environment } = useEnvironment();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showScraperModal, setShowScraperModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const { data: sessions, isLoading } = useSessions({ environment });
  const deleteSession = useDeleteSession();

  const filtered = (sessions ?? []).filter((s) => {
    const matchesSearch =
      !search ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.sessionId.toLowerCase().includes(search.toLowerCase()) ||
      s.createdBy.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || s.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "20px",
        width: "100%",
        minWidth: 0,
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          minWidth: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {/* Search */}
          <div style={{ position: "relative" }}>
            <Search
              size={14}
              style={{
                position: "absolute",
                left: "10px",
                top: "50%",
                transform: "translateY(-50%)",
                color: "#A1A1AA",
              }}
            />
            <input
              type="text"
              placeholder="Search sessions..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                height: "36px",
                paddingLeft: "32px",
                paddingRight: "12px",
                border: "1px solid #E4E4E7",
                borderRadius: "8px",
                fontSize: "13px",
                color: "#0A0A0A",
                backgroundColor: "#ffffff",
                outline: "none",
                width: "240px",
              }}
            />
          </div>

          {/* Status filter */}
          <div style={{ position: "relative" }}>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{
                height: "36px",
                paddingLeft: "10px",
                paddingRight: "28px",
                border: "1px solid #E4E4E7",
                borderRadius: "8px",
                fontSize: "13px",
                color: statusFilter === "all" ? "#71717A" : "#0A0A0A",
                backgroundColor: "#ffffff",
                outline: "none",
                appearance: "none",
                cursor: "pointer",
              }}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s === "all"
                    ? "All statuses"
                    : s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
            <ChevronDown
              size={13}
              style={{
                position: "absolute",
                right: "8px",
                top: "50%",
                transform: "translateY(-50%)",
                color: "#A1A1AA",
                pointerEvents: "none",
              }}
            />
          </div>

          {/* Result count */}
          <span
            style={{
              fontSize: "13px",
              color: "#A1A1AA",
            }}
          >
            {filtered.length} session{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          {/* Scraper import button */}
          <Button
            variant="secondary"
            icon={<Download size={14} />}
            onClick={() => setShowScraperModal(true)}
          >
            Scraper Import
          </Button>

          {/* Create button */}
          <Button
            icon={<Plus size={14} />}
            onClick={() => setShowCreateModal(true)}
          >
            New session
          </Button>
        </div>
      </div>

      {/* Table */}
      <div
        style={{
          backgroundColor: "#ffffff",
          border: "1px solid #E4E4E7",
          borderRadius: "10px",
          overflow: "hidden",
          width: "100%",
          minWidth: 0,
          maxWidth: "100%",
        }}
      >
        {isLoading ? (
          <div
            style={{
              padding: "20px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "48px 24px",
              gap: "8px",
              textAlign: "center",
            }}
          >
            <p style={{ fontSize: "14px", color: "#A1A1AA" }}>
              {search || statusFilter !== "all"
                ? "No sessions match your filters"
                : "No sessions yet"}
            </p>
            {!search && statusFilter === "all" && (
              <Button
                variant="secondary"
                icon={<Plus size={14} />}
                onClick={() => setShowCreateModal(true)}
              >
                Create first session
              </Button>
            )}
          </div>
        ) : (
          <div style={{ overflowX: "auto", width: "100%", maxWidth: "100%" }}>
            <table
              style={{
                width: "100%",
                minWidth: "1700px",
                borderCollapse: "collapse",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid #E4E4E7" }}>
                  {[
                    { label: "Session ID", width: "120px" },
                    { label: "Name", width: "auto" },
                    { label: "Created by", width: "120px" },
                    { label: "Records", width: "90px" },
                    { label: "Status", width: "130px" },
                    { label: "Modules", width: "140px" },
                    { label: "Location", width: "140px" },
                    { label: "Tagging", width: "180px" },
                    { label: "Type", width: "100px" },
                    { label: "Migrated", width: "150px" },
                    { label: "Bot ops", width: "140px" },
                    { label: "Environment", width: "110px" },
                    { label: "Created", width: "130px" },
                    { label: "", width: "44px" },
                  ].map((col) => (
                    <th
                      key={col.label}
                      style={{
                        textAlign: "left",
                        fontSize: "11px",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: "#A1A1AA",
                        fontWeight: 500,
                        padding: "12px 16px",
                        width: col.width,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((s: SeedingSession) => (
                  <tr
                    key={s._id}
                    onClick={() => navigate(`/sessions/${s._id}`)}
                    style={{
                      borderBottom: "1px solid #E4E4E7",
                      borderLeft: s.type === 'cvb'
                        ? '3px solid #0D9488'
                        : s.type === 'migration'
                        ? '3px solid #7C3AED'
                        : '3px solid transparent',
                      cursor: "pointer",
                      transition: "background-color 150ms",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor =
                        "#F4F4F5";
                      const btn = (
                        e.currentTarget as HTMLElement
                      ).querySelector(".row-delete-btn") as HTMLElement;
                      if (btn) btn.style.opacity = "1";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor =
                        "transparent";
                      const btn = (
                        e.currentTarget as HTMLElement
                      ).querySelector(".row-delete-btn") as HTMLElement;
                      if (btn) btn.style.opacity = "0";
                    }}
                  >
                    {/* Session ID */}
                    <td style={{ padding: "14px 16px" }}>
                      <span
                        style={{
                          fontFamily: "monospace",
                          fontSize: "12px",
                          color: "#0A0A0A",
                          backgroundColor: "#F4F4F5",
                          padding: "2px 6px",
                          borderRadius: "4px",
                        }}
                      >
                        {s.sessionId?.slice(-8) ?? s._id.slice(-8)}
                      </span>
                    </td>

                    {/* Name */}
                    <td style={{ padding: "14px 16px" }}>
                      <p
                        style={{
                          fontSize: "13px",
                          fontWeight: 500,
                          color: "#0A0A0A",
                          marginBottom: "2px",
                        }}
                      >
                        {s.name}
                        {s.type === 'migration' && (
                          <span style={{
                            fontSize: '10px',
                            fontWeight: 600,
                            padding: '2px 6px',
                            borderRadius: '4px',
                            backgroundColor: '#F3F0FF',
                            color: '#7C3AED',
                            marginLeft: '6px',
                            letterSpacing: '0.05em',
                          }}>
                            MIGRATION
                          </span>
                        )}
                        {s.type === 'cvb' && (
                          <span style={{
                            fontSize: '10px',
                            fontWeight: 600,
                            padding: '2px 6px',
                            borderRadius: '4px',
                            backgroundColor: '#F0FDFA',
                            color: '#0D9488',
                            marginLeft: '6px',
                            letterSpacing: '0.05em',
                          }}>
                            CVB
                          </span>
                        )}
                      </p>
                      {s.migratedFrom && (
                        <div style={{
                          fontSize: '11px',
                          color: '#A1A1AA',
                          marginTop: '2px',
                        }}>
                          from {s.migratedFrom.sessionName}{' '}
                          ({s.migratedFrom.environment})
                        </div>
                      )}
                      {s.description && (
                        <p
                          style={{
                            fontSize: "12px",
                            color: "#A1A1AA",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            maxWidth: "280px",
                          }}
                        >
                          {s.description}
                        </p>
                      )}
                    </td>

                    {/* Created by */}
                    <td
                      style={{
                        padding: "14px 16px",
                        fontSize: "13px",
                        color: "#71717A",
                      }}
                    >
                      {s.createdBy}
                    </td>

                    {/* Records */}
                    <td
                      style={{
                        padding: "14px 16px",
                        fontSize: "13px",
                        color: "#0A0A0A",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "2px",
                        }}
                      >
                        <span>{s.totalRecords} total</span>
                        {s.stats?.failed > 0 && (
                          <span
                            style={{
                              fontSize: "11px",
                              color: "#DC2626",
                            }}
                          >
                            {s.stats.failed} failed
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Status */}
                    <td style={{ padding: "14px 16px" }}>
                      <Badge status={s.status} />
                    </td>

                    {/* Modules */}
                    <td style={{ padding: "14px 16px" }}>
                      <div
                        style={{
                          display: "flex",
                          gap: "4px",
                          flexWrap: "wrap",
                        }}
                      >
                        {(s.modules ?? []).slice(0, 3).map((m) => (
                          <span
                            key={m}
                            style={{
                              fontSize: "11px",
                              color: "#71717A",
                              backgroundColor: "#F4F4F5",
                              padding: "1px 6px",
                              borderRadius: "4px",
                            }}
                          >
                            {m}
                          </span>
                        ))}
                      </div>
                    </td>

                    {/* Location */}
                    <td style={{ padding: "14px 16px" }}>
                      {(s.dominantCity || s.dominantState) ? (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            fontSize: "12px",
                            color: "#0A0A0A",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <MapPin size={12} style={{ color: "#A1A1AA" }} />
                          <span>
                            {[s.dominantCity, s.dominantState]
                              .filter(Boolean)
                              .join(", ") || "—"}
                          </span>
                        </div>
                      ) : (
                        <span style={{ color: "#A1A1AA", fontSize: "12px" }}>
                          —
                        </span>
                      )}
                    </td>

                    {/* Tagging */}
                    <td style={{ padding: "14px 16px" }}>
                      {(s.dominantIndustry || s.dominantCategory) ? (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            fontSize: "12px",
                            color: "#0A0A0A",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            maxWidth: "180px",
                          }}
                        >
                          <Tag size={12} style={{ color: "#A1A1AA", flexShrink: 0 }} />
                          <span style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}>
                            {s.dominantIndustry ?? "—"}
                            {s.dominantCategory && (
                              <>
                                {" · "}
                                <span style={{ color: "#71717A" }}>
                                  {s.dominantCategory}
                                </span>
                              </>
                            )}
                          </span>
                        </div>
                      ) : (
                        <span style={{ color: "#A1A1AA", fontSize: "12px" }}>
                          —
                        </span>
                      )}
                    </td>

                    {/* Type */}
                    <td style={{ padding: "14px 16px" }}>
                      {(() => {
                        const t = s.type ?? "standard";
                        const palette: Record<string, { bg: string; fg: string }> = {
                          standard:  { bg: "#F4F4F5", fg: "#52525B" },
                          migration: { bg: "#F3F0FF", fg: "#7C3AED" },
                          cvb:       { bg: "#F0FDFA", fg: "#0D9488" },
                        };
                        const p = palette[t] ?? palette.standard;
                        return (
                          <span
                            style={{
                              fontSize: "10px",
                              fontWeight: 600,
                              textTransform: "uppercase",
                              letterSpacing: "0.05em",
                              padding: "2px 8px",
                              borderRadius: "4px",
                              backgroundColor: p.bg,
                              color: p.fg,
                            }}
                          >
                            {t}
                          </span>
                        );
                      })()}
                    </td>

                    {/* Migrated */}
                    <td style={{ padding: "14px 16px", minWidth: "130px" }}>
                      {s.type === "migration" ? (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            fontSize: "11px",
                            padding: "2px 8px",
                            borderRadius: "999px",
                            backgroundColor: "#F4F4F5",
                            color: "#52525B",
                            whiteSpace: "nowrap",
                          }}
                        >
                          from{" "}
                          <span style={{ color: "#0A0A0A", fontWeight: 500, marginLeft: "3px" }}>
                            {s.migratedFrom?.environment ?? "—"}
                          </span>
                        </span>
                      ) : (
                        <div style={{ display: "flex", gap: "4px", flexWrap: "nowrap" }}>
                          {(["pre-prod", "production"] as const).map((env) => {
                            const hit = (s.migratedTo ?? []).some(
                              (m) => m.environment === env,
                            );
                            const label = env === "production" ? "Prod" : "Pre-prod";
                            return (
                              <span
                                key={env}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "3px",
                                  fontSize: "11px",
                                  lineHeight: 1,
                                  padding: "2px 8px",
                                  borderRadius: "999px",
                                  backgroundColor: hit ? "#F0FDF4" : "#F4F4F5",
                                  color: hit ? "#16A34A" : "#A1A1AA",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                <span style={{ fontSize: "10px", fontWeight: 700 }}>
                                  {hit ? "✓" : "–"}
                                </span>
                                {label}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </td>

                    {/* Bot ops */}
                    <td style={{ padding: "14px 16px" }}>
                      {(() => {
                        const ops = s.botOperations;
                        const items: {
                          key: string;
                          label: string;
                          stat?: { lastRunAt?: string | null; doneCount: number; failedCount: number };
                          title: string;
                        }[] = [
                          { key: "coverSync",   label: "Cover",   stat: ops?.coverSync,   title: "Cover sync" },
                          { key: "galleryMenu", label: "Gallery", stat: ops?.galleryMenu, title: "Gallery/Menu" },
                          { key: "reviews",     label: "Reviews", stat: ops?.reviews,     title: "Reviews" },
                          { key: "imageSync",   label: "Sync",    stat: ops?.imageSync,   title: "Image sync" },
                        ].filter((i) => i.stat?.lastRunAt);
                        if (items.length === 0) {
                          return (
                            <span style={{ color: "#A1A1AA", fontSize: "12px" }}>
                              —
                            </span>
                          );
                        }
                        return (
                          <div
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "6px",
                              fontSize: "11px",
                              whiteSpace: "nowrap",
                              fontVariantNumeric: "tabular-nums",
                              color: "#71717A",
                            }}
                          >
                            {items.map((i, idx) => (
                              <span
                                key={i.key}
                                title={`${i.title}: ${i.stat!.doneCount} done${
                                  i.stat!.failedCount > 0
                                    ? ` · ${i.stat!.failedCount} failed`
                                    : ""
                                }`}
                                style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}
                              >
                                {idx > 0 && (
                                  <span style={{ color: "#D4D4D8" }}>·</span>
                                )}
                                <span style={{ color: "#71717A" }}>{i.label}</span>
                                <span style={{ color: "#16A34A", fontWeight: 500 }}>
                                  {i.stat!.doneCount}
                                </span>
                                {i.stat!.failedCount > 0 && (
                                  <span style={{ color: "#DC2626", fontWeight: 500 }}>
                                    /{i.stat!.failedCount}f
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        );
                      })()}
                    </td>

                    {/* Environment */}
                    <td style={{ padding: "14px 16px" }}>
                      {ENV_PILL[s.environment] && (
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: 500,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            padding: "2px 8px",
                            borderRadius: "4px",
                            backgroundColor: ENV_PILL[s.environment].bg,
                            color: ENV_PILL[s.environment].text,
                          }}
                        >
                          {s.environment}
                        </span>
                      )}
                    </td>

                    {/* Created */}
                    <td
                      style={{
                        padding: "14px 16px",
                        fontSize: "12px",
                        color: "#A1A1AA",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatDistanceToNow(new Date(s.createdAt), {
                        addSuffix: true,
                      })}
                    </td>

                    {/* Delete */}
                    <td style={{ padding: "14px 8px" }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(s._id);
                        }}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: "4px",
                          borderRadius: "4px",
                          color: "#A1A1AA",
                          display: "flex",
                          opacity: 0,
                          transition: "opacity 150ms",
                        }}
                        className="row-delete-btn"
                        onMouseEnter={(e) =>
                          ((e.currentTarget as HTMLElement).style.color =
                            "#DC2626")
                        }
                        onMouseLeave={(e) =>
                          ((e.currentTarget as HTMLElement).style.color =
                            "#A1A1AA")
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Session Modal */}
      {showCreateModal && (
        <CreateSessionModal
          onClose={() => setShowCreateModal(false)}
          environment={environment}
        />
      )}

      {/* Scraper Import Modal */}
      {showScraperModal && (
        <ScraperImportModal
          onClose={() => setShowScraperModal(false)}
          environment={environment}
        />
      )}

      {/* Delete Session Modal */}
      {deleteTarget && (
        <AdminPasswordModal
          title="Delete session"
          warning="This will permanently delete this session, all records, and all published documents from the target DB. This cannot be undone."
          confirmLabel="Delete session"
          confirmVariant="danger"
          loading={deleteSession.isPending}
          onConfirm={async (password) => {
            try {
              await deleteSession.mutateAsync({
                sessionId: deleteTarget,
                adminPassword: password,
              });
              setDeleteTarget(null);
            } catch (err: any) {
              alert(
                err?.response?.data?.message ?? err.message ?? "Delete failed",
              );
            }
          }}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
