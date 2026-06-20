import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../utils/AppError';

export interface AdminJwtPayload extends jwt.JwtPayload {
  role: 'admin';
}

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      admin?: AdminJwtPayload;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

export function requireAdminJwt(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError(401, 'Missing or invalid Authorization header'));
  }

  const token = authHeader.slice(7);
  const secret = process.env.ADMIN_JWT_SECRET ?? process.env.JWT_SECRET;

  if (!secret) {
    return next(new AppError(500, 'JWT secret is not configured'));
  }

  try {
    const payload = jwt.verify(token, secret) as AdminJwtPayload;
    if (payload.role !== 'admin') {
      return next(new AppError(403, 'Forbidden: admin role required'));
    }
    req.admin = payload;
    next();
  } catch {
    next(new AppError(401, 'Invalid or expired token'));
  }
}
