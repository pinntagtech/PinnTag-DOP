// Orchestrates the three judges per record and aggregates
// needsReview = OR of any judgment.belowThreshold. Dry-run in Phase 3
// pilot — no DB writes; the return value is the audit blob that would
// eventually be persisted as `record.llmJudgment`.

import { Injectable, Logger } from '@nestjs/common';
import { CategoryJudge } from './judges/category-judge';
import { CityJudge } from './judges/city-judge';
import { AnomalyJudge } from './judges/anomaly-judge';
import {
  CONFIDENCE_THRESHOLD,
  FinalAction,
  JudgeInput,
  RecordJudgment,
} from './types';

@Injectable()
export class JudgmentService {
  private readonly logger = new Logger(JudgmentService.name);

  constructor(
    private readonly categoryJudge: CategoryJudge,
    private readonly cityJudge: CityJudge,
    private readonly anomalyJudge: AnomalyJudge,
  ) {}

  async judgeRecord(input: JudgeInput): Promise<RecordJudgment> {
    // Run all three judges in parallel — they're independent.
    const [category, city, anomaly] = await Promise.all([
      this.categoryJudge.run(input),
      this.cityJudge.run(input),
      this.anomalyJudge.run(input),
    ]);
    const needsReviewByJudge = {
      category: !!category.belowThreshold,
      city: !!city.belowThreshold,
      anomaly: !!anomaly.belowThreshold,
    };
    const anyBelow =
      needsReviewByJudge.category ||
      needsReviewByJudge.city ||
      needsReviewByJudge.anomaly;

    // Derive the pipeline routing decision. See FinalAction docs on types.ts.
    let finalAction: FinalAction;
    let finalActionReasoning: string;
    const catDec = category.decision;

    if (
      catDec.industryLabel === null &&
      catDec.industryConfidence >= CONFIDENCE_THRESHOLD &&
      anomaly.decision.action !== 'skip'
    ) {
      // Cross-judge signal: category is confident this isn't a consumer-app
      // business, and anomaly didn't flag it as junk. It's a real business
      // — just not for us. Pre-empts skip/review.
      finalAction = 'not_applicable';
      finalActionReasoning =
        `category judge: not a consumer-app business ` +
        `(industryConfidence=${catDec.industryConfidence.toFixed(2)})`;
    } else if (anomaly.decision.action === 'skip') {
      finalAction = 'skip';
      finalActionReasoning = `anomaly.skip: ${anomaly.reasoning ?? ''}`;
    } else if (anomaly.decision.action === 'accept_google' && !anyBelow) {
      finalAction = 'accept';
      finalActionReasoning = 'anomaly.accept_google + all judges above threshold';
    } else {
      finalAction = 'review';
      const reasons = [
        anomaly.decision.action === 'needs_review' ? 'anomaly.needs_review' : null,
        needsReviewByJudge.category ? 'category.belowThreshold' : null,
        needsReviewByJudge.city ? 'city.belowThreshold' : null,
        needsReviewByJudge.anomaly ? 'anomaly.belowThreshold' : null,
      ].filter(Boolean);
      finalActionReasoning = reasons.join(', ');
    }

    // needsReview excludes not_applicable — those never enter the queue.
    const needsReview = finalAction === 'not_applicable' ? false : anyBelow;

    return {
      category,
      city,
      anomaly,
      needsReviewByJudge,
      needsReview,
      finalAction,
      finalActionReasoning,
    };
  }

  // Batched judge. Sequential across records (Claude quota-friendly) —
  // per-record judges still run in parallel inside judgeRecord. If we
  // start pushing volume, add a concurrency cap here rather than inside
  // the individual judges.
  async judgeMany(inputs: JudgeInput[]): Promise<RecordJudgment[]> {
    const out: RecordJudgment[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const j = await this.judgeRecord(inputs[i]);
      out.push(j);
    }
    this.logger.log(
      `judgeMany: ${inputs.length} records, ` +
        `needsReview=${out.filter((j) => j.needsReview).length}`,
    );
    return out;
  }
}
