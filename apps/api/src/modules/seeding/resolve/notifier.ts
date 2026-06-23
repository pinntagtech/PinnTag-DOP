import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import * as nodemailer from 'nodemailer';
import { join } from 'path';
import { FixBatchDocument } from '../schemas/fix-batch.schema';

// Channel-agnostic surface for "a batch has completed" announcements.
// Today: EmailNotifier. Tomorrow: WhatsappNotifier / SlackNotifier —
// implement this same interface and either swap or fan-out without
// touching FixBatchService.
export interface Notifier {
  sendBatchSummary(batch: FixBatchDocument): Promise<void>;
}

interface ExampleEntry {
  businessId: string;
  businessName: string;
  reason?: string;
}

const RESOLVE_PATH = '/resolve';

@Injectable()
export class EmailNotifier implements Notifier {
  private readonly logger = new Logger(EmailNotifier.name);
  // Lazy because nodemailer.createTransport is cheap but we only need
  // it on the first batch completion — same pattern as DopMailService
  // but kept local so a missing SMTP config doesn't fail at boot.
  private transporter: nodemailer.Transporter | null = null;

  constructor(private readonly configService: ConfigService) {}

  async sendBatchSummary(batch: FixBatchDocument): Promise<void> {
    // Resolve the recipient set in priority order:
    //   1) snapshot stored on the batch (config at create-time)
    //   2) live config — picks up env edits between create+complete
    // Empty either way ⇒ silent skip per spec.
    const stored = Array.isArray(batch.recipientEmails)
      ? batch.recipientEmails
      : [];
    const fallback =
      this.configService.get<string[]>('app.notifyEmails') ?? [];
    const recipients = (stored.length > 0 ? stored : fallback).filter(
      (e) => typeof e === 'string' && e.length > 0,
    );

    if (recipients.length === 0) {
      // Per spec: NOTIFY_EMAILS unset / empty → skip silently. No
      // crash, no loud warning; just an info line so the operator
      // checking why no email arrived can see it.
      this.logger.log(
        `[NOTIFY] batch=${batch.batchId} skipped — no recipients configured`,
      );
      return;
    }

    const html = this.renderTemplate(batch);
    const subject = this.buildSubject(batch);

    try {
      const transporter = this.getTransporter();
      if (!transporter) {
        this.logger.warn(
          `[NOTIFY] batch=${batch.batchId} skipped — SMTP not configured`,
        );
        return;
      }
      const mailFrom = this.configService.get<string>('app.mailFrom');
      // Single sendMail with the full recipient list — nodemailer
      // accepts a comma-joined string OR an array on `to`. Using the
      // array form keeps each address visible in the SMTP envelope
      // (To: header) without leaking via BCC, which matches the
      // "one send, multiple To" requirement from the brief.
      await transporter.sendMail({
        from: mailFrom,
        to: recipients,
        subject,
        html,
      });
      this.logger.log(
        `[NOTIFY] batch=${batch.batchId} → ` +
          `${recipients.length} recipient(s) sent ` +
          `(${recipients.join(', ')})`,
      );
    } catch (err: any) {
      // Decoupled per the brief — email failure is logged, never
      // propagated. The fix pipeline already succeeded; the operator
      // can re-check the dopFixBatches doc directly.
      this.logger.error(
        `[NOTIFY] batch=${batch.batchId} → ${recipients.length} ` +
          `recipient(s) failed: ${err?.message}`,
      );
    }
  }

  // ── Internals ───────────────────────────────────────────────

  private getTransporter(): nodemailer.Transporter | null {
    if (this.transporter) return this.transporter;
    const host = this.configService.get<string>('app.smtpHost');
    if (!host) return null;
    this.transporter = nodemailer.createTransport({
      host,
      port: this.configService.get<number>('app.smtpPort'),
      secure: false,
      auth: {
        user: this.configService.get<string>('app.smtpUser'),
        pass: this.configService.get<string>('app.smtpPass'),
      },
    });
    return this.transporter;
  }

  private buildSubject(batch: FixBatchDocument): string {
    const label = batch.city ? batch.city : `batch ${batch.batchId}`;
    return (
      `DOP Fix complete — ${label} — ` +
      `${batch.fullyFixed}/${batch.total} fixed`
    );
  }

  private renderTemplate(batch: FixBatchDocument): string {
    const templatePath = join(
      __dirname,
      'templates',
      'dop-fix-summary.hbs',
    );
    let html = readFileSync(templatePath, 'utf-8');

    const batchLabel = batch.city
      ? batch.city
      : `Batch ${batch.batchId}`;
    const resolveUrl =
      (this.configService.get<string>('app.dopAppUrl') ?? '') +
      `${RESOLVE_PATH}?batchId=${encodeURIComponent(batch.batchId)}` +
      `&environment=${encodeURIComponent(batch.environment)}`;

    const completedAt = batch.completedAt ?? new Date();

    html = html
      .replace(/{{batchLabel}}/g, escapeHtml(batchLabel))
      .replace(/{{batchId}}/g, escapeHtml(batch.batchId))
      .replace(/{{environment}}/g, escapeHtml(batch.environment))
      .replace(/{{fullyFixed}}/g, String(batch.fullyFixed))
      .replace(/{{total}}/g, String(batch.total))
      .replace(/{{countsHours}}/g, String(batch.counts?.hours ?? 0))
      .replace(/{{countsRating}}/g, String(batch.counts?.rating ?? 0))
      .replace(/{{countsCover}}/g, String(batch.counts?.cover ?? 0))
      .replace(
        /{{countsTaxonomy}}/g,
        String(batch.counts?.taxonomy ?? 0),
      )
      .replace(/{{resolveUrl}}/g, escapeHtml(resolveUrl))
      .replace(
        /{{completedAtLabel}}/g,
        escapeHtml(completedAt.toUTCString()),
      )
      .replace(/{{examplesHtml}}/g, this.renderExamples(batch))
      .replace(/{{reviewHtml}}/g, this.renderReview(batch));

    return html;
  }

  private renderExamples(batch: FixBatchDocument): string {
    const buckets: { title: string; entries: ExampleEntry[] }[] = [
      { title: 'Fully fixed examples', entries: batch.examples?.fullyFixed ?? [] },
      { title: 'Hours written', entries: batch.examples?.hours ?? [] },
      { title: 'Rating captured', entries: batch.examples?.rating ?? [] },
      { title: 'Cover synced', entries: batch.examples?.cover ?? [] },
      { title: 'Taxonomy corrected', entries: batch.examples?.taxonomy ?? [] },
    ];
    const blocks = buckets
      .filter((b) => b.entries.length > 0)
      .map(
        (b) =>
          `<div class="bucket">
             <div class="bucket-title">${escapeHtml(b.title)}</div>
             <div class="examples">${formatNames(b.entries)}</div>
           </div>`,
      );
    return blocks.join('');
  }

  private renderReview(batch: FixBatchDocument): string {
    const entries = batch.examples?.needsReview ?? [];
    if (entries.length === 0 && batch.needsReview === 0) return '';
    const examples = formatNamesWithReason(entries);
    return `<div class="review-list">
        <div class="bucket-title">⚠️ Needs review (${batch.needsReview})</div>
        <div class="examples">${examples || '(see Resolve queue)'}</div>
      </div>`;
  }
}

function formatNames(entries: ExampleEntry[]): string {
  if (entries.length === 0) return '—';
  return entries
    .slice(0, 3)
    .map((e) => escapeHtml(e.businessName || e.businessId))
    .join(' · ');
}

function formatNamesWithReason(entries: ExampleEntry[]): string {
  if (entries.length === 0) return '';
  return entries
    .slice(0, 3)
    .map((e) => {
      const name = escapeHtml(e.businessName || e.businessId);
      const reason = e.reason
        ? ` <span style="color:#9A3412">(${escapeHtml(e.reason)})</span>`
        : '';
      return `${name}${reason}`;
    })
    .join(' · ');
}

function escapeHtml(input: string | null | undefined): string {
  if (input == null) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
