// apps/api/src/modules/seeding/judgment/ollama-client.ts
//
// Mirrors ClaudeClient.askJson<T>() exactly: same method signature, same
// null-on-failure contract. When OLLAMA_HOST is unset, returns null
// immediately — Ollama tier disabled, existing Claude-only behavior is
// preserved with zero code changes anywhere else.

import { Injectable, Logger } from '@nestjs/common';

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

@Injectable()
export class OllamaClient {
  private readonly logger = new Logger(OllamaClient.name);
  private readonly host = process.env.OLLAMA_HOST; // e.g. "http://10.x.x.x:11434"
  private readonly model = process.env.OLLAMA_MODEL || 'llama3.1:8b';

  // Lightweight per-process usage counters. DiscoveryRunService reads
  // these to compute the confidence-zero watermark (askJson returning
  // null is what the judges convert into a confidence=0 placeholder).
  // Reset via resetUsage() at the top of each run, same pattern as
  // ClaudeClient.
  private callCount = 0;
  private nullReturns = 0;

  get enabled(): boolean {
    return !!this.host;
  }

  getUsage(): { calls: number; nullReturns: number } {
    return { calls: this.callCount, nullReturns: this.nullReturns };
  }

  resetUsage(): void {
    this.callCount = 0;
    this.nullReturns = 0;
  }

  // Cheap health probe used by DiscoveryRunService's pre-flight check.
  // Hits /api/tags (the model-list endpoint) with a short timeout —
  // Ollama returns 200 with a tag list even when no generate call has
  // ever been issued, so this doesn't warm the GPU or block on
  // cold-start. Returns false on any failure (disabled, HTTP != 200,
  // network error, timeout).
  async isReachable(timeoutMs = 4000): Promise<boolean> {
    if (!this.enabled) return false;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.host}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Same contract and same call shape as ClaudeClient.askJson<T>():
   * askJson<T>({ system, user, maxTokens }) → parsed JSON of type T, or
   * null on any failure (disabled, network error, bad JSON, timeout).
   * Judges call this identically to how they already call claude.askJson —
   * only the client instance changes.
   */
  async askJson<T>(opts: {
    system: string;
    user: string;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<T | null> {
    if (!this.enabled) return null;
    this.callCount++;

    const timeoutMs = opts.timeoutMs ?? 60000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          system: opts.system,
          prompt: opts.user,
          stream: false,
          format: 'json',
          options: {
            temperature: 0, // deterministic, matches ClaudeClient's temp:0 pattern
            num_predict: opts.maxTokens ?? 300,
          },
        }),
      });

      if (!res.ok) {
        this.logger.warn(`Ollama HTTP ${res.status}: ${await res.text()}`);
        this.nullReturns++;
        return null;
      }

      const data = (await res.json()) as OllamaGenerateResponse;

      try {
        return JSON.parse(data.response) as T;
      } catch {
        this.logger.warn(`Ollama returned non-JSON response: ${data.response.slice(0, 200)}`);
        this.nullReturns++;
        return null;
      }
    } catch (err) {
      this.logger.warn(`Ollama request failed: ${(err as Error).message}`);
      this.nullReturns++;
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
