import { registerAs } from '@nestjs/config';

// Shallow validator — good enough to drop typos / empty entries from
// the comma-split. We deliberately don't pull in a full RFC-5321
// validator; SMTP will reject a malformed address at send time anyway.
const SHALLOW_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseNotifyEmails(input: string | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of input.split(',')) {
    const v = part.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    if (!SHALLOW_EMAIL_RE.test(v)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',
  googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
  pinntagApiUrl: process.env.PINNTAG_API_URL,
  pinntagApiToken: process.env.PINNTAG_API_TOKEN,
  pinntagInsiderApiKey: process.env.PINNTAG_INSIDER_API_KEY,
  pinntagBusinessUserEmail: process.env.PINNTAG_BUSINESS_USER_EMAIL,
  dopAdminPassword: process.env.DOP_ADMIN_PASSWORD,
  pythonBotUrl: process.env.PYTHON_BOT_URL,
  botWebhookSecret: process.env.BOT_WEBHOOK_SECRET,
  // Standalone address-parser microservice (apps/address-parser).
  // Holds the libpostal system dependency so the API box doesn't.
  // Default points to the second pm2 process on the same EC2 host.
  addressParserUrl:
    process.env.ADDRESS_PARSER_URL || 'http://localhost:4101',
  b2BucketName: process.env.B2_BUCKET_NAME,
  b2Region: process.env.B2_REGION,
  b2Endpoint: process.env.B2_ENDPOINT,
  b2AccessKeyId: process.env.B2_ACCESS_KEY_ID,
  b2SecretAccessKey: process.env.B2_SECRET_ACCESS_KEY,
  cdnDomain: process.env.CDN_DOMAIN,
  appEnv: process.env.APP_ENV || 'dev',
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  rootAdminEmail: process.env.ROOT_ADMIN_EMAIL,
  rootAdminPassword: process.env.ROOT_ADMIN_PASSWORD,
  rootAdminName: process.env.ROOT_ADMIN_NAME || 'Super Admin',
  smtpHost: process.env.SMTP_HOST,
  smtpPort: parseInt(process.env.SMTP_PORT || '587'),
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  mailFrom:
    process.env.MAIL_FROM || '"PinnTag DOP" <noreply@pinntag.com>',
  // Operator recipients for per-batch fix-summary emails. Source env
  // is NOTIFY_EMAILS (comma-separated). Parsed → trimmed → de-duped →
  // shallow-validated against a basic email shape. Unset / no valid
  // entries ⇒ empty array ⇒ notifications are silently skipped (the
  // fix pipeline never blocks on notification, even on misconfig).
  notifyEmails: parseNotifyEmails(process.env.NOTIFY_EMAILS),
  dopAppUrl: process.env.DOP_APP_URL || 'http://localhost:5173',
  businessLinkUrl: process.env.BUSINESS_LINK_URL,
  appsOnAir: {
    baseUrl: process.env.APPSONAIR_BASE_URL,
    consumerApiKey: process.env.APPSONAIR_CONSUMER_API_KEY,
    consumerAppId: process.env.APPSONAIR_CONSUMER_APP_ID,
    domainPrefix: process.env.APPSONAIR_DOMAIN_PREFIX,
  },
}));
