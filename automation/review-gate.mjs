#!/usr/bin/env node
// review-gate.mjs — reads a phase prompt + its Claude Code run output,
// asks Claude to review it against DOP's standing operating rules, and
// returns { decision: "CONTINUE" | "STOP", reason: "..." }.
//
// This replicates the review role a human was doing manually — it does NOT
// replace the hard gates in dop-autopilot.sh, which check first and always
// win regardless of what this returns.
//
// Requires ANTHROPIC_API_KEY in the environment.
// npm i @anthropic-ai/sdk

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';

const [, , phaseFilePath, runLogPath] = process.argv;
if (!phaseFilePath || !runLogPath) {
  console.error('Usage: review-gate.mjs <phase-prompt.md> <run-output.json>');
  process.exit(1);
}

const phasePrompt = readFileSync(phaseFilePath, 'utf8');
const runOutput = readFileSync(runLogPath, 'utf8');

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const SYSTEM = `You are reviewing a Claude Code run for PinnTag DOP (a data
operations platform). Your job is to decide whether it is safe to
automatically advance to the next queued phase, or whether a human needs to
look at this before anything else runs.

Standing operating rules for DOP (apply strictly):
- Dry-run -> hand-picked sample -> full batch is required before any bulk
  write. If this run skipped straight to a full batch without that
  progression having already happened in a prior phase, STOP.
- "Reported fixed" is not "verified fixed." If the run claims something
  works but shows no live test, count query, or diff proving it, STOP.
- Any write to production, any real spend, any deletion, any credential
  handling should already have been caught by the hard-gate patterns before
  you see this — but if you spot one anyway, STOP regardless.
- Unexpected large jumps in any count, cost, or record number without a
  clear explanation in the output should STOP for a human sanity check.
- If the run reports an error, a partial failure, or asks the user a
  question in its own output, STOP.
- If everything above is clean and the run matches what the phase prompt
  asked for, CONTINUE.

Respond with ONLY a JSON object: {"decision": "CONTINUE" | "STOP", "reason": "<one or two sentences>"}`;

const msg = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 300,
  system: SYSTEM,
  messages: [
    {
      role: 'user',
      content: `PHASE PROMPT THAT WAS SENT:\n${phasePrompt}\n\n---\n\nCLAUDE CODE RUN OUTPUT:\n${runOutput.slice(0, 15000)}`,
    },
  ],
});

const text = msg.content.find((b) => b.type === 'text')?.text ?? '{"decision":"STOP","reason":"No reviewable text in response."}';

try {
  const parsed = JSON.parse(text.trim());
  console.log(JSON.stringify(parsed));
} catch {
  console.log(JSON.stringify({ decision: 'STOP', reason: 'Reviewer output was not valid JSON — treat as unreviewed.' }));
}
