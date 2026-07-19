import type { Server } from 'http';
import type { Express, NextFunction, Request, Response } from 'express';
import { GraphQLError, parse } from 'graphql';
// Deep import — package subpath exports need moduleResolution node16+.
import { useServer } from 'graphql-ws/dist/use/ws';
import { WebSocketServer } from 'ws';
import type { Context as WsContext } from 'graphql-ws';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { assertQueryComplexity, isIntrospectionDocument } from './complexity';
import { buildContext } from './context';
import { executeGraphQL } from './execute';
import { graphqlPubSub } from './pubsub';
import { assertGraphQLRateLimit } from './rateLimit';
import { schema } from './schema';

export { schema } from './schema';
export { executeGraphQL } from './execute';
export { graphqlPubSub } from './pubsub';
export { createLoaders } from './dataloaders';
export { SCHEMA_VERSION, MIN_COMPATIBLE_VERSION, DEPRECATED_FIELDS } from './version';

export interface MountGraphQLOptions {
  /** Express path for HTTP queries/mutations. Default: /graphql */
  path?: string;
  /** Enable graphql-ws subscriptions on the same path. Default: true */
  subscriptions?: boolean;
}

/**
 * Mount GraphQL HTTP handler (queries) and optionally graphql-ws (subscriptions).
 * Applies Express IP rate limiting plus per-user GraphQL operation rate limits.
 */
export async function mountGraphQL(
  app: Express,
  server: Server,
  options: MountGraphQLOptions = {},
): Promise<{ wsServer: WebSocketServer | null }> {
  const path = options.path ?? '/graphql';
  const enableSubscriptions = options.subscriptions !== false;

  await graphqlPubSub.init();

  app.use(path, rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' }));

  app.post(path, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        query?: string;
        variables?: Record<string, unknown>;
        operationName?: string;
      };

      if (!body?.query || typeof body.query !== 'string') {
        res.status(400).json({
          errors: [{ message: 'Must provide a GraphQL query string' }],
        });
        return;
      }

      const result = await executeGraphQL({
        schema,
        query: body.query,
        variables: body.variables,
        operationName: body.operationName,
        req,
      });

      const hasRateLimit = result.errors?.some(
        (e) => e.extensions?.code === 'RATE_LIMITED',
      );
      if (hasRateLimit) {
        const retryAfter = result.errors?.[0]?.extensions?.retryAfter;
        if (typeof retryAfter === 'number') {
          res.set('Retry-After', String(retryAfter));
        }
        res.status(429).json(result);
        return;
      }

      const hasComplexity = result.errors?.some(
        (e) =>
          e.extensions?.code === 'QUERY_COMPLEXITY_EXCEEDED' ||
          e.extensions?.code === 'QUERY_DEPTH_EXCEEDED',
      );
      if (hasComplexity) {
        res.status(400).json(result);
        return;
      }

      res.status(200).json(result);
    } catch (err) {
      if (err instanceof GraphQLError) {
        const code = err.extensions?.code;
        if (code === 'RATE_LIMITED') {
          const retryAfter = err.extensions?.retryAfter;
          if (typeof retryAfter === 'number') {
            res.set('Retry-After', String(retryAfter));
          }
          res.status(429).json({ errors: [err] });
          return;
        }
        if (code === 'QUERY_COMPLEXITY_EXCEEDED' || code === 'QUERY_DEPTH_EXCEEDED') {
          res.status(400).json({ errors: [err] });
          return;
        }
      }
      if (err instanceof AppError) {
        return next(err);
      }
      next(err);
    }
  });

  let wsServer: WebSocketServer | null = null;

  if (enableSubscriptions) {
    wsServer = new WebSocketServer({ server, path });
    useServer(
      {
        schema,
        context: (ctx: WsContext) => {
          const req = (ctx.extra as { request: Request }).request;
          return buildContext(req);
        },
        onSubscribe: async (
          ctx: WsContext,
          _id: string,
          payload: { query?: string },
        ) => {
          const req = (ctx.extra as { request: Request }).request;
          const identity =
            (req as Request & { user?: { id?: string } }).user?.id ??
            (typeof req.headers['x-user-id'] === 'string'
              ? req.headers['x-user-id']
              : null) ??
            req.socket.remoteAddress ??
            'anonymous';

          await assertGraphQLRateLimit(String(identity));

          const query = payload.query;
          if (query) {
            const document = parse(query);
            if (!isIntrospectionDocument(document)) {
              assertQueryComplexity(document);
            }
          }
        },
      },
      wsServer,
    );
    logger.info(`GraphQL subscriptions ready on ws path ${path}`);
  }

  logger.info(`GraphQL HTTP endpoint mounted at POST ${path}`);
  return { wsServer };
}

export async function shutdownGraphQL(wsServer: WebSocketServer | null): Promise<void> {
  await graphqlPubSub.shutdown();
  if (wsServer) {
    await new Promise<void>((resolve) => {
      wsServer.close(() => resolve());
    });
  }
}
