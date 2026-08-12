// Rule-first industry/category mapper.
//
// Tier 1 (rule): lookupGoogleCategory — the 9-entry Beauty & Wellness
// map in resolve/google-category-map.ts. If it hits, we have the real
// industryId + categoryIds; industryConfidence=1.0, categoryConfidence=1.0.
//
// Tier 2 (local-llm): deferred — Ollama slot in later without changing
// this file's exported interface. When it lands, insert between rule
// and Claude.
//
// Tier 3 (claude-api): TWO-pass.
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
import { TaxonomyLoader, TaxonomySnapshot } from '../taxonomy-loader';
import {
  CategoryDecision,
  CONFIDENCE_THRESHOLD,
  JudgeInput,
  JudgmentDecision,
} from '../types';

@Injectable()
export class CategoryJudge {
  constructor(
    private readonly claude: ClaudeClient,
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

    // Tier 3: Claude two-pass. (Local-LLM tier 2 deferred.)
    const snap = await this.taxonomy.load();
    return await this.escalateClaude(input, snap);
  }

  private async escalateClaude(
    input: JudgeInput,
    snap: TaxonomySnapshot,
  ): Promise<JudgmentDecision<CategoryDecision>> {
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
    type IndustryReply = {
      industryLabel: string | null;
      confidence: number;
      reasoning: string;
    };
    const industryReply = await this.claude.askJson<IndustryReply>({
      system: industrySystem,
      user: industryUser,
      maxTokens: 300,
    });

    if (!industryReply) {
      return this.emptyDecision(
        'claude-api',
        'Claude industry-pass failed / no JSON returned',
      );
    }

    const industryMatch = this.taxonomy.matchIndustry(
      industryReply.industryLabel,
      snap,
    );
    const industryConfidence = clamp01(industryReply.confidence);
    const industryReasonPrefix = industryReply.reasoning || '';

    // If industry didn't resolve to a real ID (either Claude returned null
    // or the label doesn't exist in staging), we can't run pass 2 — there's
    // no restricted category list to draw from. Return with industry
    // context, categoryConfidence=0, belowThreshold=true.
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
        source: 'claude-api',
        reasoning,
        belowThreshold: true, // categoryConfidence=0 is always below threshold
      };
    }

    // ── Pass 2: categories, constrained to the picked industry ──────
    const categoriesUnderIndustry = snap.categories.filter(
      (c) => c.industryId === industryMatch.id,
    );
    if (categoriesUnderIndustry.length === 0) {
      // Industry exists but has no child categories in staging — record
      // industry, no categories to pick, needs review to add categories.
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
        source: 'claude-api',
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
    type CategoryReply = {
      categoryLabels: string[];
      confidence: number;
      reasoning: string;
    };
    const categoryReply = await this.claude.askJson<CategoryReply>({
      system: categorySystem,
      user: categoryUser,
      maxTokens: 300,
    });

    if (!categoryReply) {
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
        source: 'claude-api',
        reasoning: [
          industryReasonPrefix,
          'Claude category-pass failed / no JSON returned',
        ]
          .filter(Boolean)
          .join(' — '),
        belowThreshold: true,
      };
    }

    // Match Claude's picks against the real category list (case-insensitive).
    const matches = (categoryReply.categoryLabels ?? [])
      .map((label) => this.taxonomy.matchCategory(label, snap))
      .filter((c): c is NonNullable<typeof c> => !!c)
      // Only accept matches that belong to the chosen industry —
      // guards against name-collision across industries.
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
      source: 'claude-api',
      reasoning: [industryReasonPrefix, categoryReply.reasoning]
        .filter(Boolean)
        .join(' — '),
      belowThreshold: categoryConfidence < CONFIDENCE_THRESHOLD,
    };
  }

  private emptyDecision(
    source: 'rule' | 'claude-api',
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
