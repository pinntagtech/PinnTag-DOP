// Shared types for the judgment layer. Each judge returns a
// JudgmentDecision with the tier that answered (rule | local-llm |
// claude-api) so the audit trail on record.llmJudgment shows exactly
// how each field was decided. `local-llm` isn't wired in this pilot
// (Ollama is deferred) but the type stays here so the middle tier can
// be slotted in without changing the shape stored on records.

export type JudgmentSource = 'rule' | 'local-llm' | 'claude-api';

export interface JudgmentDecision<T = unknown> {
  decision: T;
  confidence: number; // 0.0-1.0
  source: JudgmentSource;
  reasoning?: string;
  // If the decision fell below CONFIDENCE_THRESHOLD after escalation,
  // the judge sets this so the caller doesn't have to re-check the
  // threshold. The judgment service ORs these across all judges to
  // produce the record-level needsReview.
  belowThreshold?: boolean;
}

export interface CategoryDecision {
  industryLabel: string | null; // human-readable, e.g. "Restaurants & Dining"
  industryId: string | null; // resolved from staging businessindustries by name; null if unmatched
  industryConfidence: number; // 0.0-1.0 — how sure we are about the industry pick
  categoryLabels: string[]; // human-readable list
  categoryIds: string[]; // resolved from staging businesscategories by name; empty if unmatched
  categoryConfidence: number; // 0.0-1.0 — how sure we are about the category pick
  // needsReviewByJudge.category keys off categoryConfidence specifically —
  // industry can be high-confidence while categories are unknown, and vice
  // versa. Keeping them separate avoids the earlier flattened-cap issue
  // where a category-miss dragged industry-confidence down with it.
}

export interface CityDecision {
  city: string | null;
  suburb: string | null;
  state: string | null;
}

export type AnomalyKind =
  | 'junk_name'
  | 'wrong_country'
  | 'near_duplicate'
  | 'exact_duplicate'
  | 'wrong_tenant'
  | 'renamed_business'
  | 'individual_vs_office'
  | 'none';

export interface AnomalyDecision {
  isValidBusiness: boolean;
  anomalies: AnomalyKind[];
  // Whether to accept the resolved Google identity as the source of
  // truth (rename cases where Google is current), skip the record
  // (junk name, exact duplicate), or route to human review.
  action: 'accept_google' | 'skip' | 'needs_review';
}

export interface NeedsReviewByJudge {
  category: boolean;
  city: boolean;
  anomaly: boolean;
}

// The pipeline-level routing decision for a record. Derived in
// JudgmentService from the three per-judge outputs — not one of the
// judges' own outputs. Kept as a separate concept from
// AnomalyDecision.action (which is what the anomaly judge itself
// concluded) because "not_applicable" is a cross-judge signal:
// category says "not a consumer-app business" AND anomaly says the
// record is a valid real business — different question, same record.
export type FinalAction =
  | 'accept'          // insert as clean draft; ready for downstream pipeline
  | 'review'          // insert as draft with needsReview:true
  | 'skip'            // do not insert; junk / exact duplicate / wrong tenant
  | 'not_applicable'; // do not insert; real business but out of scope for consumer directory

export interface RecordJudgment {
  category: JudgmentDecision<CategoryDecision>;
  city: JudgmentDecision<CityDecision>;
  anomaly: JudgmentDecision<AnomalyDecision>;
  // Per-judge review flags — set independently by each judge based on
  // its own belowThreshold. Downstream consumers (portal review queue,
  // manual triage) can key off the specific judge that flagged so
  // reviewers only see the failing dimension.
  needsReviewByJudge: NeedsReviewByJudge;
  // Overall = OR of the per-judge flags, EXCEPT records with
  // finalAction=='not_applicable' are cleared (they aren't inserted
  // at all, so they don't belong in a review queue).
  needsReview: boolean;
  // Pipeline routing decision — see FinalAction.
  finalAction: FinalAction;
  finalActionReasoning: string;
}

// The judge input — a normalized view of one Phase-2 resolved candidate.
// Kept intentionally decoupled from the discovery module's specific shape
// so future callers (e.g. the eventual pipeline `judge` stage) can pass
// the same view built from any upstream source.
export interface JudgeInput {
  overture: {
    name: string;
    address: string | null;
    lat: number;
    lng: number;
    category: string | null;
    sourceId: string;
  };
  resolved: {
    placeId: string;
    name: string;
    formattedAddress: string;
    lat: number;
    lng: number;
    matchConfirmed: boolean;
    matchReason: string;
  } | null;
  dedup: {
    existsInStaging: boolean;
    existsInProd: boolean;
    stagingIsSeeded: boolean | null;
    prodIsSeeded: boolean | null;
  } | null;
}

// Confidence threshold below which a decision routes to review.
// Same value for every judge for now — Phase 3 spec value 0.7.
export const CONFIDENCE_THRESHOLD = 0.7;
