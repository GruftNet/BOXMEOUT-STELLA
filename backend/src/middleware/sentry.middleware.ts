import * as Sentry from '@sentry/node';
import type { Application } from 'express';

const SENSITIVE_FIELDS = new Set(['password', 'token', 'privateKey', 'private_key']);

export function initSentry(dsn: string | undefined, environment: string): void {
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request?.data && typeof event.request.data === 'object') {
        scrub(event.request.data as Record<string, unknown>);
      }
      return event;
    },
  });
}

function scrub(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_FIELDS.has(key)) {
      obj[key] = '[Filtered]';
    } else if (obj[key] && typeof obj[key] === 'object') {
      scrub(obj[key] as Record<string, unknown>);
    }
  }
}

export function applySentryRequestHandler(app: Application): void {
  app.use(Sentry.expressErrorHandler());
}
