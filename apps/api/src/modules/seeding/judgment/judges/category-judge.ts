// Rule-first industry/category mapper.
//
// Tier 1 (rule): lookupGoogleCategory — the 9-entry Beauty & Wellness
// map in resolve/google-category-map.ts. If it hits, we have the real
// industryId + categoryIds and confidence is 1.0.
//
// Tier 2 (local-llm): deferred — Ollama slot in later without changing
// this file's exported interface. When it lands, insert between rule
// and Claude.
//
// Tier 3 (claude-api): Claude proposes freeform industry/category
// labels. We match those labels against the real staging taxonomy
// (loaded once via TaxonomyLoader). If a proposed label matches an
// existing industry/category by normalized name → use the real ID
// and confidence is Claude's self-reported. If it doesn't match →
// keep the label, no ID, mark belowThreshold so the record routes
// to review. **We never auto-create a taxonomy entry** — that's a
// deliberate manual decision per Rahul.

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
      return {
        decision: {
          industryLabel: industry?.name ?? null,
          industryId: ruleHit.industryId,
          categoryLabels: cats.map((c) => c.name),
          categoryIds: cats.map((c) => c.id),
        },
        confidence: 1.0,
        source: 'rule',
        reasoning: `google-category-map hit: "${overtureCategory}" → ${ruleHit.proposedLabel}`,
      };
    }

    // Tier 3: Claude. (Local-LLM tier 2 deferred.)
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

    const industryList = snap.industries.map((i) => i.name).join(', ');

    const system = [
      'You are a business taxonomy classifier for a consumer-app business directory.',
      'Given a business (name, address, and its raw Overture category label),',
      'pick the single best-fit industry from the provided list, plus up to 3',
      'category labels that describe the business. If the business is not a',
      'consumer-app business at all (e.g. residential, government-only, defunct),',
      'set industryLabel to null and reflect that in confidence.',
      '',
      'Respond with ONLY a JSON object of the form:',
      '{"industryLabel": string|null, "categoryLabels": string[], "confidence": number, "reasoning": string}',
      'confidence is 0.0-1.0; be conservative — below 0.7 routes to human review.',
    ].join('\n');

    const user = [
      `Business name: "${businessName}"`,
      `Address: ${address}`,
      `Raw Overture category: "${overtureCategory}"`,
      '',
      `Available industry list (pick one exactly, or null):`,
      industryList,
    ].join('\n');

    type ClaudeReply = {
      industryLabel: string | null;
      categoryLabels: string[];
      confidence: number;
      reasoning: string;
    };
    const reply = await this.claude.askJson<ClaudeReply>({
      system,
      user,
      maxTokens: 400,
    });

    if (!reply) {
      return {
        decision: {
          industryLabel: null,
          industryId: null,
          categoryLabels: [],
          categoryIds: [],
        },
        confidence: 0,
        source: 'claude-api',
        reasoning: 'Claude call failed / no JSON returned',
        belowThreshold: true,
      };
    }

    // Match Claude's proposed labels against the real taxonomy.
    const industryMatch = this.taxonomy.matchIndustry(
      reply.industryLabel,
      snap,
    );
    const categoryMatches = (reply.categoryLabels ?? [])
      .map((l) => this.taxonomy.matchCategory(l, snap))
      .filter((c): c is NonNullable<typeof c> => !!c);

    const claudeConfidence = Math.max(
      0,
      Math.min(1, Number(reply.confidence) || 0),
    );

    // If Claude proposed an industry but we couldn't map it to a real
    // taxonomy entry, we still HAVE a labeled proposal — but we can't
    // seed a categoryId from it, so downgrade the confidence + flag.
    const industryMapped = !!industryMatch;
    const anyCategoryMapped = categoryMatches.length > 0;
    let confidence = claudeConfidence;
    let reasoningExtras: string[] = [];
    if (reply.industryLabel && !industryMapped) {
      confidence = Math.min(confidence, 0.5);
      reasoningExtras.push(
        `industryLabel "${reply.industryLabel}" not in staging taxonomy`,
      );
    }
    if ((reply.categoryLabels?.length ?? 0) > 0 && !anyCategoryMapped) {
      confidence = Math.min(confidence, 0.55);
      reasoningExtras.push(
        `none of ${reply.categoryLabels?.length} proposed categories matched taxonomy`,
      );
    }

    return {
      decision: {
        industryLabel: reply.industryLabel,
        industryId: industryMatch?.id ?? null,
        categoryLabels: reply.categoryLabels ?? [],
        categoryIds: categoryMatches.map((c) => c.id),
      },
      confidence,
      source: 'claude-api',
      reasoning: [reply.reasoning, ...reasoningExtras]
        .filter(Boolean)
        .join(' — '),
      belowThreshold: confidence < CONFIDENCE_THRESHOLD,
    };
  }
}
