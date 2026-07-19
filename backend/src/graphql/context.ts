import type { Request } from 'express';
import { createLoaders, type GraphQLLoaders } from './dataloaders';

export interface GraphQLContext {
  loaders: GraphQLLoaders;
  userId: string | null;
  clientIp: string;
  identity: string;
}

export function buildContext(req?: Request): GraphQLContext {
  const userId =
    (req as Request & { user?: { id?: string } } | undefined)?.user?.id ??
    (typeof req?.header === 'function' ? req.header('x-user-id') : null) ??
    null;

  const clientIp = req?.ip ?? req?.socket?.remoteAddress ?? 'anonymous';
  const identity = userId ?? clientIp;

  return {
    loaders: createLoaders(),
    userId,
    clientIp,
    identity,
  };
}
