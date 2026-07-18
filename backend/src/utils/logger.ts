/**
 * @file logger.ts
 * @description Structured application logger.
 *
 * Exports a plain `logger` object with standard log-level methods so that
 * Jest's auto-mock (`jest.mock('../../src/utils/logger')`) can replace each
 * method with a `jest.fn()` without needing a manual factory.
 */
import pino from 'pino';

const pinoLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

export const logger = {
  trace: (obj: unknown, msg?: string) => pinoLogger.trace(obj as object, msg),
  debug: (obj: unknown, msg?: string) => pinoLogger.debug(obj as object, msg),
  info:  (obj: unknown, msg?: string) => pinoLogger.info(obj as object, msg),
  warn:  (obj: unknown, msg?: string) => pinoLogger.warn(obj as object, msg),
  error: (obj: unknown, msg?: string) => pinoLogger.error(obj as object, msg),
  fatal: (obj: unknown, msg?: string) => pinoLogger.fatal(obj as object, msg),
};
