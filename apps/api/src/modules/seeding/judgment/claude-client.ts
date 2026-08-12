// Thin wrapper around @anthropic-ai/sdk for the judgment layer.
// Structured JSON output via a strict prompt (not tool_use) so the
// interface stays trivial and we don't pay tool-call overhead for a
// simple classifier response. Temperature 0 for determinism.
//
// Uses Claude Haiku 4.5 (claude-haiku-4-5-20251001) — fastest and
// cheapest for structured extraction at the pilot volumes we care
// about. Bump to Sonnet only if Haiku produces materially worse
// judgments in the sample.

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

const MODEL_ID = 'claude-haiku-4-5-20251001';

export interface ClaudeUsageSnapshot {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

@Injectable()
export class ClaudeClient {
  private readonly logger = new Logger(ClaudeClient.name);
  private client: Anthropic | null = null;
  // Process-wide accumulators. A single deployment serves one run at a
  // time in practice (pilot batch is blocking-with-runId); if we ever
  // interleave batches, reset via resetUsage() at run start and snapshot
  // via getUsage() at end.
  private usage: ClaudeUsageSnapshot = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };

  constructor(private readonly configService: ConfigService) {}

  getUsage(): ClaudeUsageSnapshot {
    return { ...this.usage };
  }

  resetUsage(): void {
    this.usage = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    };
  }

  private getClient(): Anthropic {
    if (this.client) return this.client;
    const apiKey = this.configService.get<string>('app.anthropicApiKey');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  // Ask Claude for a JSON object. The prompt must instruct Claude to
  // respond with a JSON object and nothing else — this wrapper extracts
  // the first {...} block from the response text and parses it. If the
  // parse fails, returns null so the caller can degrade to a low-
  // confidence fallback rather than throwing.
  async askJson<T = any>(opts: {
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<T | null> {
    const client = this.getClient();
    try {
      const res = await client.messages.create({
        model: MODEL_ID,
        max_tokens: opts.maxTokens ?? 500,
        temperature: 0,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      });
      // Accumulate usage — safe under concurrency (single-thread event loop,
      // += on numbers is atomic in JS).
      this.usage.calls += 1;
      this.usage.inputTokens += res.usage?.input_tokens ?? 0;
      this.usage.outputTokens += res.usage?.output_tokens ?? 0;
      this.usage.cachedInputTokens +=
        (res.usage as any)?.cache_read_input_tokens ?? 0;

      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as any).text)
        .join('')
        .trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        this.logger.warn(`Claude returned no JSON block: ${text.slice(0, 200)}`);
        return null;
      }
      return JSON.parse(match[0]) as T;
    } catch (e) {
      // Count failed calls too — they still bill for input tokens if the
      // request reached Anthropic. Conservative for cost reporting.
      this.usage.calls += 1;
      const msg = (e as Error).message ?? String(e);
      this.logger.warn(`Claude call failed: ${msg}`);
      return null;
    }
  }
}
