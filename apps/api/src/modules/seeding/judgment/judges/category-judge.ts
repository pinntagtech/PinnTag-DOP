// Rule-first industry/category mapper.
//
// Tier 1 (rule): lookupGoogleCategory — the 9-entry Beauty & Wellness
// map in resolve/google-category-map.ts. If it hits, we have the real
// industryId + categoryIds; industryConfidence=1.0, categoryConfidence=1.0.
//
// Tier 2 (local-llm): OllamaClient, same two-pass shape as Claude (industry,
// then category constrained to that industry). When OLLAMA_HOST is set
// this tier is PRIMARY AND FINAL — whatever Ollama returns, high or low
// confidence, is the answer. Low confidence flows through to needsReview
// via the normal belowThreshold path. If Ollama itself fails (network,
// timeout, bad JSON) we return a low-confidence local-llm result rather
// than falling through to Claude, so infra failures surface honestly
// instead of being masked by a second-opinion escalation.
//
// Tier 3 (claude-api): TWO-pass, unchanged from before. Only reached when
// OLLAMA_HOST is unset — Ollama is disabled at the infra level.
//   Pass 1: given the full industry list from staging, Claude picks
//           the industry. We match the label back to a real industryId.
//   Pass 2: given ONLY the real category names that live under Claude's
//           picked industry, Claude picks up to 3 categories. Because
//           the list is constrained to real names, matches are ~100%
//           when Claude picks anything at all — no cap-on-miss logic
//           needed (which was the source of the flattened-0.55 problem
//           in the first Phase 3 pilot). Each pass reports its own
//           confidence and the two live on the decision separately.
//
// belowThreshold on this judge keys off categoryConfidence specifically
// so an industry-only-confident record (industry match found, but no
// suitable child category in the taxonomy) routes to review, while a
// category-confident record with unknown industry (shouldn't happen —
// pass 2 requires pass 1) also does.

import { Injectable } from '@nestjs/common';
import { lookupGoogleCategory } from '../../resolve/google-category-map';
import { ClaudeClient } from '../claude-client';
import { OllamaClient } from '../ollama-client';
import { TaxonomyLoader, TaxonomySnapshot } from '../taxonomy-loader';
import {
  CategoryDecision,
  CONFIDENCE_THRESHOLD,
  JudgeInput,
  JudgmentDecision,
} from '../types';

type IndustryReply = {
  industryLabel: string | null;
  confidence: number;
  reasoning: string;
};

type CategoryReply = {
  categoryLabels: string[];
  confidence: number;
  reasoning: string;
};

@Injectable()
export class CategoryJudge {
  constructor(
    private readonly claude: ClaudeClient,
    private readonly ollama: OllamaClient,
    private readonly taxonomy: TaxonomyLoader,
  ) {}

  async run(
    input: JudgeInput,
  ): Promise<JudgmentDecision<CategoryDecision>> {
    const overtureCategory = input.overture.category;

    // Tier 1: rule.
    const ruleHit = lookupGoogleCategory(overtureCategory);
    if (ruleHit) {
      const snap = await this.taxonomy.load();
      const industry = snap.industries.find((i) => i.id === ruleHit.industryId);
      const cats = ruleHit.categoryIds
        .map((id) => snap.categories.find((c) => c.id === id))
        .filter((c): c is (typeof snap.categories)[number] => !!c);
      const decision: CategoryDecision = {
        industryLabel: industry?.name ?? null,
        industryId: ruleHit.industryId,
        industryConfidence: 1.0,
        categoryLabels: cats.map((c) => c.name),
        categoryIds: cats.map((c) => c.id),
        categoryConfidence: 1.0,
      };
      return {
        decision,
        confidence: 1.0,
        source: 'rule',
        reasoning: `google-category-map hit: "${overtureCategory}" → ${ruleHit.proposedLabel}`,
        belowThreshold: false,
      };
    }

    const snap = await this.taxonomy.load();

    // Tier 2: local-llm (Ollama). PRIMARY AND FINAL when enabled — no
    // Claude escalation, even on belowThreshold or infra failure. A null
    // return from runTwoPass means the Ollama call itself failed; surface
    // that as a low-confidence local-llm result so it routes to review.
    if (this.ollama.enabled) {
      const local = await this.runTwoPass(input, snap, this.ollama, 'local-llm');
      return (
        local ??
        this.emptyDecision('local-llm', 'Ollama call failed / no JSON returned')
      );
    }

    // Tier 3: Claude two-pass. Only reached when Ollama is disabled.
    const claudeResult = await this.runTwoPass(input, snap, this.claude, 'claude-api');
    return (
      claudeResult ??
      this.emptyDecision('claude-api', 'Claude two-pass returned no result')
    );
  }

  /**
   * Shared two-pass implementation used by BOTH the Ollama tier and the
   * Claude tier — same prompts, same taxonomy-matching logic, only the
   * client (and reported source) differs. This guarantees the local model
   * is judged on an identical task to Claude, so the comparison in the
   * judge-sample rollup (categorySource: {rule, localLlm, claude}) is
   * apples-to-apples.
   */
  private async runTwoPass(
    input: JudgeInput,
    snap: TaxonomySnapshot,
    client: ClaudeClient | OllamaClient,
    source: 'local-llm' | 'claude-api',
  ): Promise<JudgmentDecision<CategoryDecision> | null> {
    const businessName = input.resolved?.name || input.overture.name;
    const address =
      input.resolved?.formattedAddress || input.overture.address || '';
    const overtureCategory = input.overture.category || '(none)';

    // ── Pass 1: industry ────────────────────────────────────────────
    const industryList = snap.industries.map((i) => i.name).join(', ');
    const industrySystem = [
      'You are a business taxonomy classifier for a consumer-app business directory.',
      'Given a business (name, address, and its raw Overture category label),',
      'pick the single best-fit industry from the provided list. If the business',
      'is not a consumer-app business at all (e.g. residential, government-only,',
      'defunct), set industryLabel to null.',
      '',
      'Respond with ONLY a JSON object of the form:',
      '{"industryLabel": string|null, "confidence": number, "reasoning": string}',
      'confidence is 0.0-1.0.',
    ].join('\n');
    const industryUser = [
      `Business name: "${businessName}"`,
      `Address: ${address}`,
      `Raw Overture category: "${overtureCategory}"`,
      '',
      'Available industry list (pick one exactly, or null):',
      industryList,
    ].join('\n');

    const industryReply = await client.askJson<IndustryReply>({
      system: industrySystem,
      user: industryUser,
      maxTokens: 300,
    });

    if (!industryReply) {
      // For the local-llm tier this just means "fall through to Claude" —
      // caller checks for null/belowThreshold and re-tries with Claude.
      return source === 'local-llm'
        ? null
        : this.emptyDecision(source, 'Industry pass failed / no JSON returned');
    }

    const industryMatch = this.taxonomy.matchIndustry(
      industryReply.industryLabel,
      snap,
    );
    const industryConfidence = clamp01(industryReply.confidence);
    const industryReasonPrefix = industryReply.reasoning || '';

    if (!industryMatch) {
      const decision: CategoryDecision = {
        industryLabel: industryReply.industryLabel,
        industryId: null,
        industryConfidence,
        categoryLabels: [],
        categoryIds: [],
        categoryConfidence: 0,
      };
      const reasoning = [
        industryReasonPrefix,
        industryReply.industryLabel
          ? `industryLabel "${industryReply.industryLabel}" not in staging taxonomy`
          : 'industryLabel returned null',
      ]
        .filter(Boolean)
        .join(' — ');
      return {
        decision,
        confidence: Math.min(industryConfidence, 0),
        source,
        reasoning,
        belowThreshold: true,
      };
    }

    // ── Pass 2: categories, constrained to the picked industry ──────
    const categoriesUnderIndustry = snap.categories.filter(
      (c) => c.industryId === industryMatch.id,
    );
    if (categoriesUnderIndustry.length === 0) {
      const decision: CategoryDecision = {
        industryLabel: industryMatch.name,
        industryId: industryMatch.id,
        industryConfidence,
        categoryLabels: [],
        categoryIds: [],
        categoryConfidence: 0,
      };
      return {
        decision,
        confidence: 0,
        source,
        reasoning: [
          industryReasonPrefix,
          `industry "${industryMatch.name}" has no categories in staging taxonomy`,
        ]
          .filter(Boolean)
          .join(' — '),
        belowThreshold: true,
      };
    }

    const categoryNamesForPrompt = categoriesUnderIndustry
      .map((c) => c.name)
      .join(', ');
    const categorySystem = [
      'You are a business taxonomy classifier. The industry has already been',
      'chosen. Pick up to 3 categories from the provided list that best',
      'describe this business. Only pick from the list — do not invent new',
      'category names. If none of the listed categories fit, return an empty',
      'array and low confidence.',
      '',
      'Respond with ONLY a JSON object of the form:',
      '{"categoryLabels": string[], "confidence": number, "reasoning": string}',
      'confidence is 0.0-1.0.',
    ].join('\n');
    const categoryUser = [
      `Business name: "${businessName}"`,
      `Address: ${address}`,
      `Raw Overture category: "${overtureCategory}"`,
      `Chosen industry: "${industryMatch.name}"`,
      '',
      'Categories under this industry (pick up to 3 exactly from this list):',
      categoryNamesForPrompt,
    ].join('\n');

    const categoryReply = await client.askJson<CategoryReply>({
      system: categorySystem,
      user: categoryUser,
      maxTokens: 300,
    });

    if (!categoryReply) {
      if (source === 'local-llm') return null;
      const decision: CategoryDecision = {
        industryLabel: industryMatch.name,
        industryId: industryMatch.id,
        industryConfidence,
        categoryLabels: [],
        categoryIds: [],
        categoryConfidence: 0,
      };
      return {
        decision,
        confidence: 0,
        source,
        reasoning: [
          industryReasonPrefix,
          'Category pass failed / no JSON returned',
        ]
          .filter(Boolean)
          .join(' — '),
        belowThreshold: true,
      };
    }

    const matches = (categoryReply.categoryLabels ?? [])
      .map((label) => this.taxonomy.matchCategory(label, snap))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .filter((c) => c.industryId === industryMatch.id);

    const categoryConfidence = clamp01(categoryReply.confidence);
    const overall = Math.min(industryConfidence, categoryConfidence);

    const decision: CategoryDecision = {
      industryLabel: industryMatch.name,
      industryId: industryMatch.id,
      industryConfidence,
      categoryLabels: categoryReply.categoryLabels ?? [],
      categoryIds: matches.map((c) => c.id),
      categoryConfidence,
    };

    return {
      decision,
      confidence: overall,
      source,
      reasoning: [industryReasonPrefix, categoryReply.reasoning]
        .filter(Boolean)
        .join(' — '),
      belowThreshold: categoryConfidence < CONFIDENCE_THRESHOLD,
    };
  }

  private emptyDecision(
    source: 'rule' | 'local-llm' | 'claude-api',
    reasoning: string,
  ): JudgmentDecision<CategoryDecision> {
    return {
      decision: {
        industryLabel: null,
        industryId: null,
        industryConfidence: 0,
        categoryLabels: [],
        categoryIds: [],
        categoryConfidence: 0,
      },
      confidence: 0,
      source,
      reasoning,
      belowThreshold: true,
    };
  }
}

function clamp01(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
