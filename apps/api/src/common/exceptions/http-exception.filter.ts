import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const errorResponse = this.buildErrorResponse(exception, request);

    if (errorResponse.statusCode >= 500) {
      this.logger.error(
        `[${errorResponse.statusCode}] ${request.method} ${request.url} — ${errorResponse.code}: ${errorResponse.message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `[${errorResponse.statusCode}] ${request.method} ${request.url} — ${errorResponse.code}: ${errorResponse.message}`,
      );
    }

    response.status(errorResponse.statusCode).json(errorResponse);
  }

  private buildErrorResponse(exception: unknown, request: Request) {
    const base = {
      success: false as const,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
    };

    // ── AppException (our typed exceptions) ──────────────
    if (exception instanceof AppException) {
      const body = exception.getResponse() as any;
      return {
        ...base,
        statusCode: exception.getStatus(),
        code: body.code,
        message: body.message,
        ...(body.field && { field: body.field }),
        ...(body.details && { details: body.details }),
      };
    }

    // ── NestJS HttpException ──────────────────────────────
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const status = exception.getStatus();

      // class-validator errors come as array
      if (
        typeof body === 'object' &&
        body !== null &&
        'message' in body &&
        Array.isArray((body as any).message)
      ) {
        const validationErrors = (body as any).message as string[];
        return {
          ...base,
          statusCode: 400,
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Request validation failed',
          details: {
            errors: validationErrors.map((msg) => ({
              message: msg,
            })),
          },
        };
      }

      return {
        ...base,
        statusCode: status,
        code: this.statusToCode(status),
        message:
          typeof body === 'string'
            ? body
            : (body as any).message || 'An error occurred',
      };
    }

    // ── Mongoose CastError ────────────────────────────────
    if (exception instanceof mongoose.Error.CastError) {
      return {
        ...base,
        statusCode: 400,
        code: ErrorCode.DB_CAST_ERROR,
        message: `Invalid value for field "${exception.path}"`,
        field: exception.path,
        details: {
          received: exception.value,
          expectedType: exception.kind,
          tip:
            exception.kind === 'ObjectId'
              ? 'Must be a 24-character hex string e.g. 507f1f77bcf86cd799439011'
              : `Must be a valid ${exception.kind}`,
        },
      };
    }

    // ── Mongoose ValidationError ──────────────────────────
    if (exception instanceof mongoose.Error.ValidationError) {
      const errors: Record<string, string> = {};
      for (const [key, err] of Object.entries(exception.errors)) {
        errors[key] = err.message;
      }
      return {
        ...base,
        statusCode: 400,
        code: ErrorCode.DB_VALIDATION_ERROR,
        message: 'Database schema validation failed',
        details: { errors },
      };
    }

    // ── MongoDB Duplicate Key (code 11000) ────────────────
    if (
      exception instanceof Error &&
      'code' in exception &&
      (exception as any).code === 11000
    ) {
      const keyValue = (exception as any).keyValue || {};
      const field = Object.keys(keyValue)[0] || 'unknown';
      const value = keyValue[field];
      return {
        ...base,
        statusCode: 409,
        code: ErrorCode.DB_DUPLICATE_KEY,
        message: `Duplicate value for unique field "${field}"`,
        field,
        details: { field, value },
      };
    }

    // ── Mongoose Connection Error ─────────────────────────
    if (
      exception instanceof Error &&
      exception.message?.includes('ECONNREFUSED')
    ) {
      return {
        ...base,
        statusCode: 503,
        code: ErrorCode.DB_CONNECTION_FAILED,
        message: 'Database connection refused',
        details: { tip: 'Check that MongoDB is running' },
      };
    }

    // ── SyntaxError (malformed JSON body) ─────────────────
    if (exception instanceof SyntaxError && 'body' in exception) {
      return {
        ...base,
        statusCode: 400,
        code: ErrorCode.INVALID_JSON_BODY,
        message: 'Request body contains invalid JSON',
        details: {
          tip: 'Check for trailing commas, missing quotes, or unmatched brackets',
        },
      };
    }

    // ── Unknown error ─────────────────────────────────────
    return {
      ...base,
      statusCode: 500,
      code: ErrorCode.INTERNAL_ERROR,
      message:
        process.env.NODE_ENV === 'development' && exception instanceof Error
          ? exception.message
          : 'An unexpected error occurred',
      ...(process.env.NODE_ENV === 'development' &&
        exception instanceof Error && {
          details: { stack: exception.stack?.split('\n').slice(0, 5) },
        }),
    };
  }

  private statusToCode(status: number): ErrorCode {
    const map: Record<number, ErrorCode> = {
      400: ErrorCode.VALIDATION_FAILED,
      401: ErrorCode.UNAUTHORIZED,
      403: ErrorCode.FORBIDDEN,
      404: ErrorCode.RESOURCE_NOT_FOUND,
      409: ErrorCode.RESOURCE_CONFLICT,
      422: ErrorCode.INVALID_PIPELINE_STAGE,
      500: ErrorCode.INTERNAL_ERROR,
      501: ErrorCode.NOT_IMPLEMENTED,
      503: ErrorCode.SERVICE_UNAVAILABLE,
    };
    return map[status] ?? ErrorCode.INTERNAL_ERROR;
  }
}
