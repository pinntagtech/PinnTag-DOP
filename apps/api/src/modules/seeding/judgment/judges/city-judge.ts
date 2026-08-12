// Rule-first city/suburb parser.
//
// Tier 1 (rule): mirrors seeding-pipeline.service.ts:deriveCityFromAddressLine1
// — split on comma, require the last segment to match "XX 12345" (state+ZIP),
// take second-to-last as city. State comes from the last segment. Suburb
// (neighborhood between street and city) is not extractable from a plain
// USPS-format address string, so the rule always returns suburb=null and
// only Claude proposes one for the town/village-legal-split cases the spec
// calls out.
//
// Tier 2 (local-llm): deferred.
//
// Tier 3 (claude-api): parse the address as prose, propose city + suburb +
// state. Only invoked when the rule fails (ambiguous_reason non-null) OR
// when the rule returned a city but the address contains a suburb hint
// like "Buckhead" or "Midtown" that the plain rule can't surface.

import { Injectable } from '@nestjs/common';
import { ClaudeClient } from '../claude-client';
import {
  CityDecision,
  CONFIDENCE_THRESHOLD,
  JudgeInput,
  JudgmentDecision,
} from '../types';

const STATE_ZIP_RE = /^[A-Za-z]{2}\s+\d{5}(-\d{4})?$/;
// Anything that looks like a state code in the tail. Case-insensitive
// so we don't need to duplicate.
const STATE_CODE_RE = /\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\s*(?:,\s*USA)?\s*$/i;

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

@Injectable()
export class CityJudge {
  constructor(private readonly claude: ClaudeClient) {}

  async run(input: JudgeInput): Promise<JudgmentDecision<CityDecision>> {
    // Prefer Google's canonical formattedAddress — it's already
    // normalized to the "…, city, ST 12345, USA" form the rule expects.
    const address =
      input.resolved?.formattedAddress || input.overture.address || '';

    const ruleOut = deriveCityAndState(address);
    if (ruleOut.city && ruleOut.state) {
      // Rule was decisive. Suburb stays null; if we want suburb signal
      // we escalate to Claude in a follow-up (out of Phase 3 pilot scope).
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

    // Rule failed → escalate.
    return await this.escalateClaude(input, address, ruleOut.reason ?? null);
  }

  private async escalateClaude(
    input: JudgeInput,
    address: string,
    ruleReason: string | null,
  ): Promise<JudgmentDecision<CityDecision>> {
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

    type ClaudeReply = {
      city: string | null;
      suburb: string | null;
      state: string | null;
      confidence: number;
      reasoning: string;
    };
    const reply = await this.claude.askJson<ClaudeReply>({
      system,
      user,
      maxTokens: 300,
    });
    if (!reply) {
      return {
        decision: { city: null, suburb: null, state: null },
        confidence: 0,
        source: 'claude-api',
        reasoning: 'Claude call failed / no JSON returned',
        belowThreshold: true,
      };
    }
    const confidence = Math.max(
      0,
      Math.min(1, Number(reply.confidence) || 0),
    );
    return {
      decision: {
        city: reply.city,
        suburb: reply.suburb,
        state: reply.state,
      },
      confidence,
      source: 'claude-api',
      reasoning: reply.reasoning,
      belowThreshold: confidence < CONFIDENCE_THRESHOLD,
    };
  }
}
