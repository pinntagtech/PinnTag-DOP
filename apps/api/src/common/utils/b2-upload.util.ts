import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';

export interface B2UploadResult {
  key: string;
  url: string;
}

function safeObjectKeyPart(input: string): string {
  const normalized = input.normalize('NFKD');
  const safe = normalized
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe.length ? safe : 'file';
}

function manipulateImageName(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  const extension = lastDot !== -1
    ? filename.slice(lastDot).toLowerCase()
    : '.jpg';
  const base = lastDot !== -1
    ? filename.slice(0, lastDot)
    : filename;
  const safeBase = safeObjectKeyPart(base);
  return `${safeBase}-${Date.now()}${extension}`;
}

export async function uploadBufferToB2(
  buffer: Buffer,
  filename: string,
  mimetype: string,
  configService: ConfigService,
): Promise<B2UploadResult> {
  const bucket = configService.get<string>('app.b2BucketName')!;
  const region = configService.get<string>('app.b2Region')!;
  const endpoint = configService.get<string>('app.b2Endpoint')!;
  const accessKeyId = configService.get<string>('app.b2AccessKeyId')!;
  const secretAccessKey = configService.get<string>('app.b2SecretAccessKey')!;
  const cdnDomain = configService.get<string>('app.cdnDomain')!;
  const appEnv = configService.get<string>('app.appEnv') || 'dev';

  const s3Client = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  const safeName = manipulateImageName(filename);
  const key = `${appEnv}/${safeName}`.replace(/^\/+/, '');

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
      ContentDisposition: 'inline',
      CacheControl: 'public, max-age=31536000',
    }),
  );

  return {
    key,
    url: `https://${cdnDomain}/${key}`,
  };
}
