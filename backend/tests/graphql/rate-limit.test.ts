import { assertGraphQLRateLimit, resetGraphQLRateLimit } from '../../src/graphql/rateLimit';

const incr = jest.fn();
const expire = jest.fn();
const ttl = jest.fn();
const del = jest.fn();

jest.mock('../../src/config/redis', () => ({
  redis: {
    incr: (...args: unknown[]) => incr(...args),
    expire: (...args: unknown[]) => expire(...args),
    ttl: (...args: unknown[]) => ttl(...args),
    del: (...args: unknown[]) => del(...args),
  },
}));

describe('GraphQL per-user rate limiting', () => {
  beforeEach(() => {
    incr.mockReset();
    expire.mockReset();
    ttl.mockReset();
    del.mockReset();
  });

  it('allows requests under the max', async () => {
    incr.mockResolvedValue(1);
    expire.mockResolvedValue(1);
    await expect(assertGraphQLRateLimit('user-1', { max: 5 })).resolves.toBeUndefined();
    expect(incr).toHaveBeenCalledWith('rl:graphql:user-1');
    expect(expire).toHaveBeenCalled();
  });

  it('rejects when over the max with RATE_LIMITED', async () => {
    incr.mockResolvedValue(6);
    ttl.mockResolvedValue(42);
    await expect(assertGraphQLRateLimit('user-1', { max: 5 })).rejects.toMatchObject({
      message: 'Too Many Requests',
      extensions: { code: 'RATE_LIMITED', retryAfter: 42 },
    });
  });

  it('resetGraphQLRateLimit deletes the key', async () => {
    del.mockResolvedValue(1);
    await resetGraphQLRateLimit('user-1');
    expect(del).toHaveBeenCalledWith('rl:graphql:user-1');
  });
});
