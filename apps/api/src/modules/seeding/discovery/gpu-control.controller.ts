// Slack-triggered control for the GPU/Ollama EC2 instance.
//
// Endpoint: POST /api/v1/seeding/discovery/gpu-control
// Wired to a single /gpu slash command in Slack — the subcommand
// (start | stop | status) rides in the `text` field. Chose one
// command over three (/startai, /stopai, /checkai) so we only
// register + verify one Slack endpoint and Slack's autocomplete
// hint can list the actions.
//
// Auth: Slack request signing.
//   sig_basestring = 'v0:' + timestamp + ':' + raw_body
//   expected       = 'v0=' + hmac_sha256(SLACK_SIGNING_SECRET, base)
//   compare to X-Slack-Signature using timing-safe equality
// Timestamp also gates replay (±5min window). No other auth path
// is accepted — no x-bot-secret, no admin password. Slack's
// signing secret is the ONLY key that can invoke this.
//
// Slack expects a response within 3 seconds. status awaits the
// describe call (typically <1s). start and stop fire-and-forget
// the AWS call, ack immediately, and log any failure — the
// instance itself takes 60-120s to transition, so awaiting would
// blow the 3s budget.
//
// Signature verification needs the RAW request body. This handler
// prefers (req as any).rawBody when present (available if a
// verify-callback is wired into express.urlencoded in main.ts),
// otherwise it reconstructs the body from parsed fields via
// URLSearchParams.toString() — insertion-order-preserving,
// x-www-form-urlencoded serialization that matches what Slack
// sends. If signature-mismatch flakes ever appear in prod (which
// would mean parse-then-serialize is losing bytes), the fix is a
// one-line verify callback in main.ts's urlencoded() call —
// intentionally kept optional here to avoid modifying main.ts for
// this isolated endpoint.
//
// Minimal IAM policy required on the DOP API EC2's instance role
// (attach in AWS console — do NOT extend any existing broader
// role). ACCOUNT_ID is the AWS account number where both the DOP
// EC2 and the GPU instance live:
//
// {
//   "Version": "2012-10-17",
//   "Statement": [
//     {
//       "Sid": "GpuInstanceStartStop",
//       "Effect": "Allow",
//       "Action": [
//         "ec2:StartInstances",
//         "ec2:StopInstances"
//       ],
//       "Resource":
//         "arn:aws:ec2:us-east-1:ACCOUNT_ID:instance/i-01a1215af34b1e95f"
//     },
//     {
//       "Sid": "GpuInstanceDescribe",
//       "Effect": "Allow",
//       "Action": "ec2:DescribeInstances",
//       "Resource": "*"
//     }
//   ]
// }
//
// Note on DescribeInstances: AWS does not support resource-level
// permissions or condition keys on this action; Resource MUST be
// "*". This is documented AWS behavior, not an oversight. The
// blast radius is bounded (read-only metadata listing) and the
// two mutating actions ARE resource-scoped to just the GPU
// instance ARN, which is the important half.

import {
  Controller,
  Post,
  Req,
  Res,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as crypto from 'crypto';
import { Public } from '../../auth/decorators/public.decorator';
import { GpuControlService } from './gpu-control.service';

const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 300;

@Controller('seeding/discovery')
export class GpuControlController {
  private readonly logger = new Logger(GpuControlController.name);

  constructor(private readonly gpu: GpuControlService) {}

  @Public()
  @Post('gpu-control')
  async handle(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const secret = process.env.SLACK_SIGNING_SECRET;
    if (!secret) {
      // Server misconfig. Ephemeral so it's visible in Slack to
      // whoever ran the command, without leaking the message to
      // the channel.
      res.status(500).json({
        response_type: 'ephemeral',
        text: '⚠️ SLACK_SIGNING_SECRET is not set on the DOP API server.',
      });
      return;
    }

    const sig = String(req.headers['x-slack-signature'] || '');
    const ts = String(req.headers['x-slack-request-timestamp'] || '');
    if (!sig || !ts) {
      res.status(401).json({ text: 'missing slack headers' });
      return;
    }

    const tsNum = Number.parseInt(ts, 10);
    const now = Math.floor(Date.now() / 1000);
    if (
      !Number.isFinite(tsNum)
      || Math.abs(now - tsNum) > SLACK_TIMESTAMP_TOLERANCE_SECONDS
    ) {
      res.status(401).json({ text: 'stale slack timestamp' });
      return;
    }

    // See file header for rawBody-vs-reconstruct rationale.
    const rawBody = this._getRawBody(req);

    const base = `v0:${ts}:${rawBody}`;
    const expected =
      'v0='
      + crypto.createHmac('sha256', secret).update(base).digest('hex');

    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (
      sigBuf.length !== expBuf.length
      || !crypto.timingSafeEqual(sigBuf, expBuf)
    ) {
      this.logger.warn(
        `[GPU] Slack signature mismatch (ts=${ts})`,
      );
      res.status(401).json({ text: 'signature mismatch' });
      return;
    }

    // ── Parse the Slack payload ──
    const body = (req.body || {}) as {
      command?: string;
      text?: string;
      user_name?: string;
    };
    const action = String(body.text || '').trim().toLowerCase();
    const user = String(body.user_name || 'unknown');

    if (!['start', 'stop', 'status'].includes(action)) {
      res.status(200).json({
        response_type: 'ephemeral',
        text:
          'usage: `/gpu start` · `/gpu stop` · `/gpu status`',
      });
      return;
    }

    // ── status: await the describe (typically <1s) ──
    if (action === 'status') {
      try {
        const state = await this.gpu.status();
        res.status(200).json({
          response_type: 'in_channel',
          text: `AI server: *${state}* (checked by @${user})`,
        });
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        this.logger.error(`[GPU] status failed: ${msg}`);
        res.status(200).json({
          response_type: 'ephemeral',
          text: `AI server status query failed: ${msg}`,
        });
      }
      return;
    }

    // ── start / stop: ack immediately, fire in background ──
    // start-instances / stop-instances themselves return quickly,
    // but the instance state transition takes tens of seconds to
    // minutes. Slack's 3s window rules out awaiting anything but
    // a status describe. Any AWS failure gets logged, not sent
    // back to Slack — user can /gpu status to see current state.
    if (action === 'start') {
      res.status(200).json({
        response_type: 'in_channel',
        text:
          `AI server starting… (requested by @${user}) — `
          + `takes ~1-2 min to reach *running*.`,
      });
      this.gpu.start().catch((e) => {
        this.logger.error(
          `[GPU] start failed (user=${user}): ${e?.message ?? e}`,
        );
      });
      return;
    }

    if (action === 'stop') {
      res.status(200).json({
        response_type: 'in_channel',
        text:
          `AI server stopping… (requested by @${user})`,
      });
      this.gpu.stop().catch((e) => {
        this.logger.error(
          `[GPU] stop failed (user=${user}): ${e?.message ?? e}`,
        );
      });
      return;
    }
  }

  // Extract the exact bytes Slack signed. Preference order:
  //   1) req.rawBody as Buffer — present iff main.ts wires a
  //      verify callback into express.urlencoded(). Byte-exact.
  //   2) URLSearchParams round-trip of the parsed body — Node's
  //      URLSearchParams uses WHATWG x-www-form-urlencoded
  //      encoding, which matches what Slack sends. Insertion
  //      order is preserved by V8 for string keys, and
  //      body-parser inserts in Slack's send order. Non-string
  //      or nested values shouldn't appear in Slack payloads
  //      (all fields are flat strings) — anything unusual gets
  //      coerced to string and will still verify iff Slack
  //      really sent that value.
  private _getRawBody(req: Request): string {
    const raw = (req as any).rawBody;
    if (raw instanceof Buffer) return raw.toString('utf8');
    if (typeof raw === 'string') return raw;
    const parsed = (req.body || {}) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(parsed)) {
      params.append(k, v == null ? '' : String(v));
    }
    return params.toString();
  }
}
