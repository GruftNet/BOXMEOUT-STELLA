import * as Sentry from '@sentry/nextjs';
import { sanitizeObject } from './src/lib/error';

const SENTRY_DSN = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn: SENTRY_DSN || 'https://examplePublicKey@o0.ingest.sentry.io/0',
  
  // Adjust this value in production, or use tracesSampler for greater control
  tracesSampleRate: 1.0,
  
  // Setting this option to true will print useful information to the console while setting up Sentry.
  debug: false,

  beforeSend(event) {
    // Filter sensitive data from global errors before they leave the edge runtime
    if (event.extra) {
      event.extra = sanitizeObject(event.extra);
    }
    
    if (event.request?.headers) {
      const sensitiveHeaders = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];
      for (const header of sensitiveHeaders) {
        if (event.request.headers[header]) {
          event.request.headers[header] = '[REDACTED]';
        }
      }
    }

    return event;
  },
});
