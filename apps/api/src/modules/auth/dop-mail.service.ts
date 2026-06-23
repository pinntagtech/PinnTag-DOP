import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import * as nodemailer from 'nodemailer';
import { join } from 'path';

@Injectable()
export class DopMailService {
  private readonly logger = new Logger(DopMailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('app.smtpHost'),
      port: this.configService.get<number>('app.smtpPort'),
      secure: false,
      auth: {
        user: this.configService.get<string>('app.smtpUser'),
        pass: this.configService.get<string>('app.smtpPass'),
      },
    });
  }

  async sendWelcomeEmail(payload: {
    name: string;
    email: string;
    password: string;
    role: string;
    environments: string[];
  }): Promise<void> {
    const loginUrl =
      this.configService.get<string>('app.dopAppUrl') + '/login';

    const mailFrom = this.configService.get<string>('app.mailFrom');

    const templatePath = join(
      __dirname,
      'templates',
      'dop-welcome.hbs',
    );

    let html = readFileSync(templatePath, 'utf-8');

    html = html
      .replace(/{{name}}/g, payload.name)
      .replace(/{{email}}/g, payload.email)
      .replace(/{{password}}/g, payload.password)
      .replace(/{{role}}/g, payload.role.replace('_', ' '))
      .replace(/{{environments}}/g, payload.environments.join(', '))
      .replace(/{{loginUrl}}/g, loginUrl);

    try {
      await this.transporter.sendMail({
        from: mailFrom,
        to: payload.email,
        subject: 'Welcome to PinnTag DOP — Your credentials',
        html,
      });

      this.logger.log(
        `[MAIL] Welcome email sent to ${payload.email}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[MAIL] Failed to send welcome email to ` +
          `${payload.email}: ${err.message}`,
      );
    }
  }
}
