/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Sentry from '@sentry/nextjs';

export enum ErrorCategory {
  USER = 'user',
  BUG = 'bug',
  NETWORK = 'network',
  WALLET = 'wallet',
}

/**
 * Custom application error class supporting categorization and user-friendly messages.
 */
export class AppError extends Error {
  public category: ErrorCategory;
  public details?: Record<string, any>;
  public userFriendlyMessage: string;

  constructor(
    message: string,
    category: ErrorCategory = ErrorCategory.BUG,
    userFriendlyMessage?: string,
    details?: Record<string, any>
  ) {
    super(message);
    this.name = 'AppError';
    this.category = category;
    this.userFriendlyMessage = userFriendlyMessage || 'An unexpected error occurred. Please try again.';
    this.details = details;

    // Set prototype explicitly for correct prototype chain inheritance in all JS runtimes
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Scans and redacts sensitive patterns (such as Stellar secrets/private keys starting with 'S', hex keys, JWTs, and email addresses).
 */
export function sanitizeString(val: string): string {
  // Regex to match Stellar secret keys (starts with S, uppercase, 56 characters)
  const stellarSecretRegex = /\bS[A-D][A-Z2-7]{54}\b/g;
  // Regex to match general private keys / hex keys (64 hex characters)
  const hexKeyRegex = /\b[a-fA-F0-9]{64}\b/g;
  // Regex to match standard email addresses
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
  // Regex to match JWT tokens
  const jwtRegex = /\beyJhbGciOi[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*\b/g;

  return val
    .replace(stellarSecretRegex, '[REDACTED_STELLAR_SECRET]')
    .replace(hexKeyRegex, '[REDACTED_HEX_KEY]')
    .replace(emailRegex, '[REDACTED_EMAIL]')
    .replace(jwtRegex, '[REDACTED_JWT]');
}

/**
 * Recursively redacts sensitive keys and values in objects/arrays.
 */
export function sanitizeObject(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return sanitizeString(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }

  if (typeof obj === 'object') {
    const isError = obj instanceof Error || 
                    Object.prototype.toString.call(obj) === '[object Error]' ||
                    (obj && typeof obj.message === 'string' && typeof obj.name === 'string');

    if (isError) {
      // Serialize Error details safely
      const serializedError: Record<string, any> = {
        name: obj.name,
        message: sanitizeString(obj.message),
        stack: obj.stack ? sanitizeString(obj.stack) : undefined,
      };
      // Copy over other properties if AppError
      if (obj instanceof AppError) {
        serializedError.category = obj.category;
        serializedError.userFriendlyMessage = obj.userFriendlyMessage;
        serializedError.details = sanitizeObject(obj.details);
      }
      return serializedError;
    }

    const sanitized: Record<string, any> = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const lowerKey = key.toLowerCase();
        const isSensitiveKey =
          lowerKey.includes('password') ||
          lowerKey.includes('secret') ||
          lowerKey.includes('key') ||
          lowerKey.includes('seed') ||
          lowerKey.includes('token') ||
          lowerKey.includes('authorization') ||
          lowerKey.includes('mnemonic') ||
          lowerKey.includes('private');

        if (isSensitiveKey) {
          sanitized[key] = '[REDACTED_SENSITIVE_FIELD]';
        } else {
          sanitized[key] = sanitizeObject(obj[key]);
        }
      }
    }
    return sanitized;
  }

  return obj;
}

/**
 * Main utility function to log/report errors to Sentry with safety sanitization.
 */
export function logError(error: unknown, context?: Record<string, any>): void {
  // Determine if it is a user error or a system/bug error
  let category = ErrorCategory.BUG;
  const tags: Record<string, string> = { error_type: 'bug' };

  if (error instanceof AppError) {
    category = error.category;
    tags.error_category = error.category;
    tags.error_type = error.category === ErrorCategory.USER ? 'user_error' : 'system_bug';
  } else if (error instanceof Error) {
    // If standard error, try to infer category or classify as BUG
    tags.error_type = 'system_bug';
  } else {
    tags.error_type = 'unknown';
  }

  // Sanitize the error message, context, and details
  const sanitizedContext = context ? sanitizeObject(context) : {};
  
  // Format the exception safely
  let exceptionToReport: Error;
  if (error instanceof Error) {
    // Create a new sanitized error to avoid mutating the original error's message/stack
    const message = sanitizeString(error.message);
    const sanitizedError = new Error(message);
    sanitizedError.name = error.name;
    sanitizedError.stack = error.stack ? sanitizeString(error.stack) : undefined;
    
    if (error instanceof AppError) {
      const appErr = sanitizedError as any;
      appErr.category = error.category;
      appErr.userFriendlyMessage = error.userFriendlyMessage;
      appErr.details = sanitizeObject(error.details);
    }
    exceptionToReport = sanitizedError;
  } else {
    exceptionToReport = new Error(typeof error === 'string' ? sanitizeString(error) : 'Unknown error');
  }

  // In development, log to console
  if (process.env.NODE_ENV === 'development') {
    console.error('[ErrorLogger]', exceptionToReport, {
      category,
      context: sanitizedContext,
    });
  }

  // Send to Sentry with context and tags
  Sentry.withScope((scope) => {
    scope.setTags(tags);
    scope.setExtra('context', sanitizedContext);
    if (error instanceof AppError && error.details) {
      scope.setExtra('details', sanitizeObject(error.details));
    }
    Sentry.captureException(exceptionToReport);
  });
}
