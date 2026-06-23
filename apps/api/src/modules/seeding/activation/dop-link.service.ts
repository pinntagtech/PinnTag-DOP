import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

// Byte-faithful port of PinnTag's generateShortLink call inside
// generateBusinessQR (CONSUMER apps-on-air keys). Same body, same headers,
// same socialMeta string. On any failure — missing config, network, non-2xx,
// missing brandedLink — we fall back to the long URL so the seeded
// appRedirectLink field is never null.
@Injectable()
export class DopLinkService {
  private readonly logger = new Logger(DopLinkService.name);

  constructor(private readonly config: ConfigService) {}

  async generateBusinessShareLink(
    businessId: string,
    businessName: string,
    imageUrl: string,
  ): Promise<string> {
    const businessLinkUrl = this.config.get<string>('app.businessLinkUrl');
    const baseUrl = this.config.get<string>('app.appsOnAir.baseUrl');
    const apiKey = this.config.get<string>('app.appsOnAir.consumerApiKey');
    const appId = this.config.get<string>('app.appsOnAir.consumerAppId');
    const domainPrefix = this.config.get<string>('app.appsOnAir.domainPrefix');

    const longUrl = `${businessLinkUrl ?? ''}${businessId}`;

    if (!businessLinkUrl || !baseUrl || !apiKey || !appId) {
      this.logger.warn(
        'AppsOnAir config missing — appRedirectLink falling back to long URL',
      );
      return longUrl;
    }

    try {
      const response = await axios.post(
        baseUrl,
        {
          data: {
            url: longUrl,
            name: 'AppsOnAir',
            urlPrefix: domainPrefix,
            socialMeta: {
              // EXACT string format from PinnTag's generateBusinessQR.
              // The double name is intentional and matches the live backend —
              // do not "fix" without a product decision, or seeded share
              // cards will diverge from registered ones.
              title:
                `${businessName} by ${businessName} ` +
                `brought to you by Pinntag.`,
              description: `Join ${businessName}`,
              imageUrl,
            },
            isOpenInAndroidApp: true,
            isOpenInBrowserAndroid: false,
            isOpenInIosApp: true,
            isOpenInBrowserApple: false,
          },
        },
        {
          headers: {
            'x-api-key': apiKey,
            'x-app-key': appId,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );
      return response.data?.brandedLink || longUrl;
    } catch (error: any) {
      const detail = error?.response?.data
        ? JSON.stringify(error.response.data)
        : (error?.message ?? String(error));
      this.logger.error(
        `AppsOnAir link failed for ${businessId}: ${detail} ` +
          `— using long URL fallback`,
      );
      return longUrl;
    }
  }
}
