// Rule-first city/suburb parser.
//
// Tier 1 (rule): mirrors seeding-pipeline.service.ts:deriveCityFromAddressLine1
// — split on comma, require the last segment to match "XX 12345" (state+ZIP),
// take second-to-last as city. State comes from the last segment. Suburb
// (neighborhood between street and city) is not extractable from a plain
// USPS-format address string, so the rule always returns suburb=null and
// only the LLM tiers propose one for the town/village-legal-split cases the
// spec calls out.
//
// Tier 2 (local-llm): OllamaClient, same single-pass shape as Claude below.
// When OLLAMA_HOST is set this tier is PRIMARY AND FINAL — whatever Ollama
// returns, high or low confidence, is the answer. Low confidence flows
// through to needsReview via the normal belowThreshold path. On infra
// failure (null return) we surface a low-confidence local-llm result
// rather than falling through to Claude.
//
// Tier 3 (claude-api): parse the address as prose, propose city + suburb +
// state. Only invoked when the rule fails AND Ollama is disabled at the
// infra level (OLLAMA_HOST unset) — never as a per-record fallback.

import { Injectable } from '@nestjs/common';
import { ClaudeClient } from '../claude-client';
import { OllamaClient } from '../ollama-client';
import {
  CityDecision,
  CONFIDENCE_THRESHOLD,
  JudgeInput,
  JudgmentDecision,
} from '../types';

const STATE_ZIP_RE = /^[A-Za-z]{2}\s+\d{5}(-\d{4})?$/;

function deriveCityAndState(address: string): {
  city: string | null;
  state: string | null;
  reason?: string;
} {
  const raw = (address ?? '').toString().trim();
  if (!raw) return { city: null, state: null, reason: 'empty_address' };
  const withoutCountry = raw
    .replace(/,\s*(USA|United States(?: of America)?)\s*$/i, '')
    .trim();
  const parts = withoutCountry
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return { city: null, state: null, reason: 'fewer_than_2_segments' };
  }
  const lastSegment = parts[parts.length - 1];
  if (!STATE_ZIP_RE.test(lastSegment)) {
    return { city: null, state: null, reason: 'no_state_zip_segment' };
  }
  const stateMatch = lastSegment.match(/^([A-Za-z]{2})/);
  const state = stateMatch ? stateMatch[1].toUpperCase() : null;
  const candidate = parts[parts.length - 2].trim();
  if (!candidate) return { city: null, state, reason: 'empty_derived' };
  if (/^\d+$/.test(candidate)) {
    return { city: null, state, reason: 'numeric_derived' };
  }
  return { city: candidate, state };
}

type LlmReply = {
  city: string | null;
  suburb: string | null;
  state: string | null;
  confidence: number;
  reasoning: string;
};

@Injectable()
export class CityJudge {
  constructor(
    private readonly claude: ClaudeClient,
    private readonly ollama: OllamaClient,
  ) {}

  async run(input: JudgeInput): Promise<JudgmentDecision<CityDecision>> {
    // Prefer Google's canonical formattedAddress — it's already
    // normalized to the "…, city, ST 12345, USA" form the rule expects.
    const address =
      input.resolved?.formattedAddress || input.overture.address || '';

    const ruleOut = deriveCityAndState(address);
    if (ruleOut.city && ruleOut.state) {
      // Rule was decisive. Suburb stays null; if we want suburb signal
      // we escalate to an LLM tier in a follow-up (out of Phase 3 scope).
      return {
        decision: {
          city: ruleOut.city,
          suburb: null,
          state: ruleOut.state,
        },
        confidence: 0.95,
        source: 'rule',
        reasoning: `parsed from "${address}"`,
      };
    }

    // Rule failed → tier 2: local-llm. PRIMARY AND FINAL when enabled —
    // whatever Ollama returns is the answer; low confidence routes to
    // review via belowThreshold. Null (Ollama failure) is surfaced as a
    // low-confidence local-llm result, NOT escalated to Claude.
    if (this.ollama.enabled) {
      const local = await this.escalate(
        input,
        address,
        ruleOut.reason ?? null,
        this.ollama,
        'local-llm',
      );
      return (
        local ?? {
          decision: { city: null, suburb: null, state: null },
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
      address,
      ruleOut.reason ?? null,
      this.claude,
      'claude-api',
    );
    return (
      claudeResult ?? {
        decision: { city: null, suburb: null, state: null },
        confidence: 0,
        source: 'claude-api',
        reasoning: 'Claude call failed / no JSON returned',
        belowThreshold: true,
      }
    );
  }

  /**
   * Shared single-pass implementation used by BOTH the Ollama tier and the
   * Claude tier — identical prompt, only the client (and reported source)
   * differs, so the judge-sample rollup comparison stays apples-to-apples.
   */
  private async escalate(
    input: JudgeInput,
    address: string,
    ruleReason: string | null,
    client: ClaudeClient | OllamaClient,
    source: 'local-llm' | 'claude-api',
  ): Promise<JudgmentDecision<CityDecision> | null> {
    const businessName = input.resolved?.name || input.overture.name;
    const lat = input.overture.lat;
    const lng = input.overture.lng;

    const system = [
      'You extract city, suburb (neighborhood), and US state from a business address string.',
      'Some addresses use town/village names that split from the postal city — return',
      'the legal municipality as `city` and the postal or neighborhood as `suburb` in',
      'that case. If the address does not clearly identify a US city, set city=null.',
      '',
      'Respond with ONLY a JSON object of the form:',
      '{"city": string|null, "suburb": string|null, "state": string|null,',
      ' "confidence": number, "reasoning": string}',
      'confidence is 0.0-1.0; be conservative — below 0.7 routes to human review.',
    ].join('\n');

    const user = [
      `Business: "${businessName}"`,
      `Address: ${address}`,
      `Coordinates: ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      ruleReason ? `(Rule-based parse failed: ${ruleReason})` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const reply = await client.askJson<LlmReply>({
      system,
      user,
      maxTokens: 300,
    });

    if (!reply) {
      // local-llm tier: null means "fall through to Claude", not a
      // terminal failure — caller handles this.
      if (source === 'local-llm') return null;
      return {
        decision: { city: null, suburb: null, state: null },
        confidence: 0,
        source,
        reasoning: 'Claude call failed / no JSON returned',
        belowThreshold: true,
      };
    }

    const confidence = Math.max(0, Math.min(1, Number(reply.confidence) || 0));
    return {
      decision: {
        city: reply.city,
        suburb: reply.suburb,
        state: reply.state,
      },
      confidence,
      source,
      reasoning: reply.reasoning,
      belowThreshold: confidence < CONFIDENCE_THRESHOLD,
    };
  }
}
