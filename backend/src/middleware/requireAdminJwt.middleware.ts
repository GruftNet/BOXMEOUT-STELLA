/**
 * @file requireAdminJwt.middleware.ts
 * @description Express middleware that validates a Bearer JWT and enforces admin role.
 */
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../utils/AppError';

export function requireAdminJwt(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const authHeader = (req as Request & { headers: Record<string, string> }).headers
    .authorization as string | undefined;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(new AppError(401, 'Missing or malformed Authorization header'));
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET ?? '';

  try {
    const payload = jwt.verify(token, secret) as { role?: string };

    if (payload.role !== 'admin') {
      next(new AppError(403, 'Forbidden: admin role required'));
      return;
    }

    next();
  } catch {
    next(new AppError(401, 'Invalid or expired token'));
  }
}
