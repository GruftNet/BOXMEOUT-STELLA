import express from 'express';
import http from 'http';
import pinoHttp from 'pino-http';
import { closeRedisClients } from './config/redis';
import { errorMiddleware } from './middleware/error.middleware';
import { AppError } from './utils/AppError';
import { logger } from './utils/logger';
import {
  mountGraphQL,
  shutdownGraphQL,
} from './graphql';
import {
  initActivityFeed,
  shutdownActivityFeed,
} from './websocket/realtime';
import type { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 3001);

const app = express();
app.use(pinoHttp({ logger }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// 404 after routes are mounted in bootstrap()
const server = http.createServer(app);
let graphqlWs: WebSocketServer | null = null;

async function bootstrap(): Promise<void> {
  const mounted = await mountGraphQL(app, server, { path: '/graphql' });
  graphqlWs = mounted.wsServer;

  app.use((_req, _res, next) => {
    next(AppError.notFound('Route not found'));
  });
  app.use(errorMiddleware);

  await initActivityFeed(server);

  server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`GraphQL endpoint at http://localhost:${PORT}/graphql`);
  });
}

const shutdown = async (): Promise<void> => {
  await shutdownGraphQL(graphqlWs);
  await shutdownActivityFeed();
  await closeRedisClients();
  server.close(() => process.exit(0));
};

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});

void bootstrap().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});

export { app, server };
