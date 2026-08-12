// Orchestrates the three judges per record and aggregates
// needsReview = OR of any judgment.belowThreshold. Dry-run in Phase 3
// pilot — no DB writes; the return value is the audit blob that would
// eventually be persisted as `record.llmJudgment`.

import { Injectable, Logger } from '@nestjs/common';
import { CategoryJudge } from './judges/category-judge';
import { CityJudge } from './judges/city-judge';
import { AnomalyJudge } from './judges/anomaly-judge';
import { JudgeInput, RecordJudgment } from './types';

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
    const needsReview =
      !!category.belowThreshold ||
      !!city.belowThreshold ||
      !!anomaly.belowThreshold;
    return { category, city, anomaly, needsReview };
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
