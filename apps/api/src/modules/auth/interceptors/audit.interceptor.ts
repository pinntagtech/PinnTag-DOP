import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuthService } from '../auth.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private readonly authService: AuthService) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) return next.handle();

    const method = request.method;
    const url = request.url;
    const body = request.body;
    const params = request.params;
    const ip = request.ip;
    const userAgent = request.headers['user-agent'];

    const action = this.deriveAction(method, url);
    const resource = this.deriveResource(url);
    const resourceId = params?.id || params?.rid || null;
    const environment =
      body?.environment || request.query?.environment || null;

    if (method === 'GET') return next.handle();

    return next.handle().pipe(
      tap({
        next: () => {
          this.authService
            .logAudit({
              userId: user._id,
              userEmail: user.email,
              userName: user.name,
              action,
              resource,
              resourceId,
              details: this.sanitizeBody(body),
              environment,
              ip,
              userAgent,
              outcome: 'success',
            })
            .catch(() => {});
        },
        error: (err) => {
          this.authService
            .logAudit({
              userId: user._id,
              userEmail: user.email,
              userName: user.name,
              action,
              resource,
              resourceId,
              details: {
                error: err.message,
                ...this.sanitizeBody(body),
              },
              environment,
              ip,
              userAgent,
              outcome: 'failure',
            })
            .catch(() => {});
        },
      }),
    );
  }

  private deriveAction(method: string, url: string): string {
    const path = url.split('?')[0].replace('/api/v1/', '');
    const parts = path.split('/');

    const actionMap: Record<string, string> = {
      'POST:sessions': 'session.create',
      'POST:sessions/*/validate': 'session.validate',
      'POST:sessions/*/transform': 'session.transform',
      'POST:sessions/*/enrich': 'session.enrich',
      'POST:sessions/*/approve': 'session.approve',
      'POST:sessions/*/publish': 'session.publish',
      'POST:sessions/*/reset': 'session.reset',
      'DELETE:sessions/*': 'session.delete',
      'POST:sessions/*/migrate': 'session.migrate',
      'POST:sessions/*/trigger-bot': 'bot.trigger',
      'POST:bot/webhook': 'bot.webhook',
      'POST:auth/login': 'auth.login',
      'POST:auth/logout': 'auth.logout',
      'POST:auth/users': 'user.create',
      'PATCH:auth/users/*': 'user.update',
      'DELETE:auth/users/*': 'user.delete',
      'POST:sessions/*/import-cvb': 'cvb.import',
      'POST:sessions/*/cvb-validate': 'cvb.validate',
      'POST:sessions/*/cvb-autofix': 'cvb.autofix',
      'POST:records/*/cvb-apply-fix': 'cvb.fix.apply',
      'POST:records/*/cvb-reject-fix': 'cvb.fix.reject',
    };

    const key = `${method}:${parts.slice(0, 3).join('/')}`;
    return (
      actionMap[key] ||
      `${method.toLowerCase()}.${parts[parts.length - 1]}`
    );
  }

  private deriveResource(url: string): string {
    const path = url.split('?')[0].replace('/api/v1/', '');
    if (path.startsWith('seeding/sessions')) return 'session';
    if (path.startsWith('seeding/records')) return 'record';
    if (path.startsWith('seeding/cvb')) return 'cvb';
    if (path.startsWith('seeding/bot')) return 'bot';
    if (path.startsWith('auth/users')) return 'user';
    if (path.startsWith('auth')) return 'auth';
    return 'unknown';
  }

  private sanitizeBody(body: any): Record<string, any> {
    if (!body) return {};
    const sanitized = { ...body };
    delete sanitized.password;
    delete sanitized.passwordHash;
    delete sanitized.refreshToken;
    delete sanitized.adminPassword;
    if (sanitized.records?.length > 5) {
      sanitized.records = `[${sanitized.records.length} records]`;
    }
    if (sanitized.businessIds?.length > 5) {
      sanitized.businessIds = `[${sanitized.businessIds.length} ids]`;
    }
    return sanitized;
  }
}
