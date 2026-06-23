import { HttpException } from '@nestjs/common';
import { ErrorCode, ErrorHttpStatus } from './error-codes';

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  field?: string;
  details?: Record<string, any>;
  cause?: unknown;
}

export class AppException extends HttpException {
  public readonly code: ErrorCode;
  public readonly field?: string;
  public readonly details?: Record<string, any>;

  constructor(options: AppErrorOptions) {
    const status = ErrorHttpStatus[options.code] ?? 500;
    super(
      {
        code: options.code,
        message: options.message,
        ...(options.field && { field: options.field }),
        ...(options.details && { details: options.details }),
      },
      status,
    );
    this.code = options.code;
    this.field = options.field;
    this.details = options.details;
  }
}
