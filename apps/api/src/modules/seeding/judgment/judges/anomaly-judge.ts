// Anomaly / validity judge. This is the tier that resolves the Phase 2
// matchConfirmed:false population — renamed businesses, suite-tenant
// mismatches, junk-name rows, individual-vs-office, etc.
//
// Tier 1 (rule) does the cheap deterministic checks:
//   - junk name: single all-punctuation token, geographic label
//     ("Atlanta, GA - Downtown"), or all-caps single word
//   - exact duplicate: dedup2 already flagged existsInStaging or
//     existsInProd → skip
//   - wrong country: Overture coord inside US bbox + Google's
//     formattedAddress country segment is not US (or vice versa)
//
// Tier 2 (local-llm): OllamaClient, same classification task as Claude
// below. When OLLAMA_HOST is set this tier is PRIMARY AND FINAL —
// whatever Ollama returns is the answer, including belowThreshold and
// needs_review, which route through the normal review path. Infra
// failure (null return) is surfaced as a low-confidence local-llm
// result, NOT escalated to Claude.
//
// Tier 3 (claude-api): for anything that survives the rules and has
// matchConfirmed=false, ask Claude to categorize: is this a rename
// (accept_google), a wrong-tenant / different-business (needs_review),
// a junk row (skip), an individual-vs-office (needs_review), or a
// legit business the confirmation thresholds were just too strict on
// (accept_google)? We ALSO run Claude for the matchConfirmed=true
// cases when the dedup flags something odd, but with a quick prompt.

import { Injectable } from '@nestjs/common';
import { ClaudeClient } from '../claude-client';
import { OllamaClient } from '../ollama-client';
import {
  AnomalyDecision,
  AnomalyKind,
  CONFIDENCE_THRESHOLD,
  JudgeInput,
  JudgmentDecision,
} from '../types';

// US lower-48 bbox (roughly). Used for the wrong-country coord check.
const US_LAT_MIN = 24.396;
const US_LAT_MAX = 49.384;
const US_LNG_MIN = -125.001;
const US_LNG_MAX = -66.934;

// Geographic-label junk-name patterns. Add cases as we see them.
const GEO_LABEL_RE =
  /^(atlanta|nyc|new york|manhattan|brooklyn|queens|bronx|staten island|downtown|midtown|uptown)[\s,-]/i;

function looksLikeJunkName(name: string): boolean {
  if (!name || !name.trim()) return true;
  const trimmed = name.trim();
  if (GEO_LABEL_RE.test(trimmed)) return true;
  if (/^[A-Z]{4,}$/.test(trimmed) && !trimmed.includes(' ')) return true;
  if (!/[A-Za-z]/.test(trimmed)) return true;
  return false;
}

function inUsBox(lat: number, lng: number): boolean {
  return (
    lat >= US_LAT_MIN &&
    lat <= US_LAT_MAX &&
    lng >= US_LNG_MIN &&
    lng <= US_LNG_MAX
  );
}

function addressCountryIsUs(address: string | null): boolean | null {
  if (!address) return null;
  const tail = address.trim().toLowerCase();
  if (/,\s*usa\s*$/.test(tail)) return true;
  if (/,\s*united states\s*$/.test(tail)) return true;
  return null;
}

type LlmReply = {
  isValidBusiness: boolean;
  anomalies: AnomalyKind[];
  action: 'accept_google' | 'skip' | 'needs_review';
  confidence: number;
  reasoning: string;
};

@Injectable()
export class AnomalyJudge {
  constructor(
    private readonly claude: ClaudeClient,
    private readonly ollama: OllamaClient,
  ) {}

  async run(input: JudgeInput): Promise<JudgmentDecision<AnomalyDecision>> {
    const anomalies: AnomalyKind[] = [];
    const overtureName = input.overture.name;
    const resolvedAddr = input.resolved?.formattedAddress ?? null;

    if (looksLikeJunkName(overtureName)) anomalies.push('junk_name');

    if (input.dedup?.existsInStaging || input.dedup?.existsInProd) {
      anomalies.push('exact_duplicate');
    }

    const inUs = inUsBox(input.overture.lat, input.overture.lng);
    const addrUs = addressCountryIsUs(resolvedAddr);
    if (inUs && addrUs === false) anomalies.push('wrong_country');
    if (!inUs && addrUs === true) anomalies.push('wrong_country');

    // Rule: definitive skips.
    if (anomalies.includes('junk_name')) {
      return {
        decision: {
          isValidBusiness: false,
          anomalies,
          action: 'skip',
        },
        confidence: 0.9,
        source: 'rule',
        reasoning: `overture name looks like a junk/geographic label: "${overtureName}"`,
      };
    }
    if (anomalies.includes('exact_duplicate')) {
      return {
        decision: {
          isValidBusiness: true,
          anomalies,
          action: 'skip',
        },
        confidence: 0.95,
        source: 'rule',
        reasoning:
          `placeId already present in ` +
          [
            input.dedup?.existsInStaging ? 'staging' : null,
            input.dedup?.existsInProd ? 'prod' : null,
          ]
            .filter(Boolean)
            .join(' + '),
      };
    }

    // Rule: match confirmed with no other flags → accept.
    const matchConfirmed = !!input.resolved?.matchConfirmed;
    if (matchConfirmed && anomalies.length === 0) {
      return {
        decision: {
          isValidBusiness: true,
          anomalies: ['none'],
          action: 'accept_google',
        },
        confidence: 0.9,
        source: 'rule',
        reasoning: 'match_confirmed and no rule anomalies',
      };
    }

    // Tier 2: local-llm. PRIMARY AND FINAL when enabled — no Claude
    // escalation. Null (Ollama failure) is surfaced as a low-confidence
    // local-llm result routed to review.
    if (this.ollama.enabled) {
      const local = await this.escalate(input, anomalies, this.ollama, 'local-llm');
      return (
        local ?? {
          decision: {
            isValidBusiness: true,
            anomalies: anomalies.length ? anomalies : (['none'] as AnomalyKind[]),
            action: 'needs_review',
          },
          confidence: 0,
          source: 'local-llm',
          reasoning: 'Ollama call failed / no JSON returned',
          belowThreshold: true,
        }
      );
    }

    // Tier 3: Claude fallback. Only reached when Ollama is disabled.
    const claudeResult = await this.escalate(
      input,
      anomalies,
      this.claude,
      'claude-api',
    );
    return (
      claudeResult ?? {
        decision: {
          isValidBusiness: true,
          anomalies: anomalies.length ? anomalies : (['none'] as AnomalyKind[]),
          action: 'needs_review',
        },
        confidence: 0,
        source: 'claude-api',
        reasoning: 'Claude call failed / no JSON returned',
        belowThreshold: true,
      }
    );
  }

  /**
   * Shared classification task used by BOTH the Ollama tier and the
   * Claude tier — identical prompt, only the client (and reported
   * source) differs, so the judge-sample rollup comparison stays
   * apples-to-apples.
   */
  private async escalate(
    input: JudgeInput,
    ruleAnomalies: AnomalyKind[],
    client: ClaudeClient | OllamaClient,
    source: 'local-llm' | 'claude-api',
  ): Promise<JudgmentDecision<AnomalyDecision> | null> {
    const system = [
      'You inspect a business-directory candidate that failed automatic match confirmation.',
      'The candidate has an Overture-source (name, address, category, coord) and a Google',
      'Places result at the same coord neighborhood. Classify what kind of mismatch this',
      'is and decide the action:',
      '',
      '- "accept_google": Google is the authoritative current identity. Choose when the',
      '  Overture record is a stale name for the SAME real business (rename/rebrand),',
      '  or the confirmation thresholds were just too strict on formal-vs-shortened name',
      '  variants of the same firm.',
      '- "skip": the record is not worth seeding. Choose for junk names, non-business',
      '  entries, or when Google returned a totally unrelated business at the same',
      '  street with no useful signal.',
      '- "needs_review": ambiguous — a suite-tenant mismatch (different real businesses',
      '  at the same address), individual-vs-office (a person\'s listing vs the parent',
      '  brokerage), or anything you can\'t confidently call.',
      '',
      'Respond with ONLY a JSON object of the form:',
      '{"isValidBusiness": boolean, "anomalies": string[], "action": "accept_google"|"skip"|"needs_review",',
      ' "confidence": number, "reasoning": string}',
      '',
      'Valid anomaly strings: "junk_name","wrong_country","near_duplicate","exact_duplicate",',
      '"wrong_tenant","renamed_business","individual_vs_office","none".',
      'confidence is 0.0-1.0; be conservative — below 0.7 routes to human review.',
    ].join('\n');

    const dedupNote = input.dedup?.existsInStaging || input.dedup?.existsInProd
      ? `Dedup pass 2: placeId ALREADY in ${[
          input.dedup.existsInStaging ? 'staging' : null,
          input.dedup.existsInProd ? 'prod' : null,
        ]
          .filter(Boolean)
          .join(' + ')}`
      : 'Dedup pass 2: placeId is new to both staging and prod';

    const user = [
      '=== Overture (source) ===',
      `Name:     "${input.overture.name}"`,
      `Address:  ${input.overture.address ?? '(none)'}`,
      `Category: ${input.overture.category ?? '(none)'}`,
      `Coord:    ${input.overture.lat.toFixed(5)}, ${input.overture.lng.toFixed(5)}`,
      '',
      '=== Google Places (resolved via searchText, same coord neighborhood) ===',
      input.resolved
        ? [
            `Name:     "${input.resolved.name}"`,
            `Address:  ${input.resolved.formattedAddress}`,
            `Coord:    ${input.resolved.lat.toFixed(5)}, ${input.resolved.lng.toFixed(5)}`,
            `Match:    matchConfirmed=${input.resolved.matchConfirmed} (${input.resolved.matchReason})`,
          ].join('\n')
        : '(no resolve — Places returned nothing in the 500m box)',
      '',
      dedupNote,
      '',
      ruleAnomalies.length
        ? `Deterministic rule flags already fired: ${ruleAnomalies.join(', ')}`
        : 'No deterministic rule flags fired.',
    ].join('\n');

    const reply = await client.askJson<LlmReply>({
      system,
      user,
      maxTokens: 400,
    });

    if (!reply) {
      if (source === 'local-llm') return null;
      return {
        decision: {
          isValidBusiness: true,
          anomalies: ruleAnomalies.length ? ruleAnomalies : (['none'] as AnomalyKind[]),
          action: 'needs_review',
        },
        confidence: 0,
        source,
        reasoning: 'Claude call failed / no JSON returned',
        belowThreshold: true,
      };
    }

    const confidence = Math.max(0, Math.min(1, Number(reply.confidence) || 0));
    const merged = Array.from(
      new Set([...(reply.anomalies ?? []), ...ruleAnomalies]),
    ) as AnomalyKind[];
    const belowThreshold =
      confidence < CONFIDENCE_THRESHOLD || reply.action === 'needs_review';

    return {
      decision: {
        isValidBusiness: !!reply.isValidBusiness,
        anomalies: merged.length ? merged : (['none'] as AnomalyKind[]),
        action: reply.action,
      },
      confidence,
      source,
      reasoning: reply.reasoning,
      belowThreshold,
    };
  }
}
