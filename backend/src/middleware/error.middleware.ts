/**
 * @file error.middleware.ts
 * @description Express error-handling middleware — converts AppError and
 * plain Errors to structured JSON responses.
 */
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    // Log server-side errors only
    if (err.statusCode >= 500) {
      logger.error({
        message: err.message,
        statusCode: err.statusCode,
        details: err.details,
      });
    }

    const body: Record<string, unknown> = {
      code: err.statusCode,
      message: err.message,
    };
    if (err.details !== undefined) {
      body.details = err.details;
    }
    res.status(err.statusCode).json({ error: body });
    return;
  }

  if (err instanceof Error) {
    logger.error({ message: err.message, stack: err.stack });

    const message =
      process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;

    res.status(500).json({ error: { code: 500, message } });
    return;
  }

  // Non-Error throw (string, null, etc.)
  res.status(500).json({ error: { code: 500, message: 'Internal server error' } });
}
