import { Injectable, Logger, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { Readable } from 'stream';

// Strict whitelist — operators MUST NOT be able to pull arbitrary keys
// out of the bucket via this proxy. Path traversal is also blocked at
// the controller (basename only) but we re-check here.
export const BOT_SOURCE_WHITELIST = [
  'main.py',
  'scraper_bulk.py',
  'auto_setup_cookies.py',
  'requirements.txt',
  'version.json',
  'update.sh',
  'update.ps1',
] as const;

export type BotSourceFile = (typeof BOT_SOURCE_WHITELIST)[number];

export interface BotSourceManifest {
  version: string;
  files: { name: BotSourceFile; sha256: string }[];
}

export interface BotSourceObject {
  body: Buffer;
  contentType: string;
}

@Injectable()
export class BotSourceService {
  private readonly logger = new Logger(BotSourceService.name);
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly region: string;
  private readonly s3: S3Client;

  constructor(private readonly configService: ConfigService) {
    this.bucket =
      this.configService.get<string>('BOT_SOURCE_S3_BUCKET') ||
      'pinntag-dop-portal';
    this.prefix =
      this.configService.get<string>('BOT_SOURCE_S3_PREFIX') || 'bot-source';
    this.region =
      this.configService.get<string>('BOT_SOURCE_S3_REGION') ||
      this.configService.get<string>('AWS_REGION') ||
      'us-east-1';

    // Credentials come from the default AWS credential provider chain
    // (env vars, shared config, EC2/ECS instance role, etc.). The bucket
    // is regional AWS S3, NOT the B2 endpoint used elsewhere.
    this.s3 = new S3Client({ region: this.region });
  }

  isWhitelisted(name: string): name is BotSourceFile {
    return (BOT_SOURCE_WHITELIST as readonly string[]).includes(name);
  }

  async getManifest(): Promise<BotSourceManifest> {
    // version.json is authoritative for the version string. If it's
    // missing we 502 — operators need a clear signal so the upload step
    // gets caught, not a silently-empty manifest.
    const versionObj = await this.fetchObject('version.json');
    let version: string;
    try {
      const parsed = JSON.parse(versionObj.body.toString('utf-8'));
      version = String(parsed.version || '').trim();
      if (!version) throw new Error('empty version');
    } catch (err: any) {
      this.logger.error(
        `[BOT_SOURCE] version.json malformed: ${err.message}`,
      );
      throw new HttpException(
        'Bot source version.json is malformed',
        502,
      );
    }

    const files: { name: BotSourceFile; sha256: string }[] = [];
    for (const name of BOT_SOURCE_WHITELIST) {
      try {
        const obj = await this.fetchObject(name);
        files.push({
          name,
          sha256: createHash('sha256').update(obj.body).digest('hex'),
        });
      } catch (err: any) {
        // Skip files that aren't uploaded yet — version.json + main.py
        // are the only ones we strictly require; the rest are optional.
        // We still log so a missing update.sh on staging is visible.
        if (name === 'version.json' || name === 'main.py') {
          throw err;
        }
        this.logger.warn(
          `[BOT_SOURCE] skipping ${name} in manifest: ${err.message}`,
        );
      }
    }

    return { version, files };
  }

  async getFile(name: BotSourceFile): Promise<BotSourceObject> {
    return this.fetchObject(name);
  }

  private async fetchObject(name: string): Promise<BotSourceObject> {
    const key = `${this.prefix}/${name}`;
    try {
      const out = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = await this.streamToBuffer(out.Body as Readable);
      const contentType =
        out.ContentType || this.guessContentType(name);
      return { body, contentType };
    } catch (err: any) {
      const code = err?.name || err?.Code || '';
      this.logger.error(
        `[BOT_SOURCE] s3 get failed bucket=${this.bucket} key=${key} ` +
          `code=${code} msg=${err?.message}`,
      );
      if (code === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        throw new HttpException(`Bot source not found: ${name}`, 404);
      }
      throw new HttpException(
        `Failed to read bot source ${name} from S3: ${err?.message || code}`,
        502,
      );
    }
  }

  private streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c) =>
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
      );
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  private guessContentType(name: string): string {
    if (name.endsWith('.json')) return 'application/json';
    if (name.endsWith('.py')) return 'text/x-python; charset=utf-8';
    if (name.endsWith('.sh')) return 'text/x-shellscript; charset=utf-8';
    if (name.endsWith('.ps1')) return 'text/plain; charset=utf-8';
    if (name.endsWith('.txt')) return 'text/plain; charset=utf-8';
    return 'application/octet-stream';
  }
}
