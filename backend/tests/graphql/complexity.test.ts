import { parse } from 'graphql';
import { assertQueryComplexity, DEFAULT_MAX_COMPLEXITY } from '../../src/graphql/complexity';
import { executeGraphQL } from '../../src/graphql/execute';
import { schema } from '../../src/graphql/schema';
import { createLoaders } from '../../src/graphql/dataloaders';

jest.mock('../../src/services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  redis: {
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(60),
    del: jest.fn().mockResolvedValue(1),
  },
}));

describe('GraphQL query complexity limits', () => {
  it('rejects queries exceeding max depth', () => {
    const document = parse(`
      query {
        user(address: "G") {
          bets {
            market {
              bets {
                market {
                  bets {
                    market {
                      bets {
                        market { marketId }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `);

    expect(() => assertQueryComplexity(document, { maxDepth: 5 })).toThrow(/depth/i);
  });

  it('rejects queries exceeding max complexity via executeGraphQL', async () => {
    await expect(
      executeGraphQL({
        schema,
        query: `
          query {
            markets {
              edges {
                node {
                  bets { id market { bets { id market { bets { id } } } } }
                  positions { id market { positions { id } } }
                  trades { id market { trades { id } } }
                }
              }
            }
          }
        `,
        skipRateLimit: true,
        maxComplexity: 50,
        context: { loaders: createLoaders(), userId: null, clientIp: '127.0.0.1', identity: 'test' },
      }),
    ).rejects.toMatchObject({
      extensions: { code: 'QUERY_COMPLEXITY_EXCEEDED' },
    });
  });

  it('allows simple queries under the default budget', () => {
    const document = parse(`{ schemaInfo { version } market(id: "x") { marketId } }`);
    const { complexity } = assertQueryComplexity(document);
    expect(complexity).toBeLessThan(DEFAULT_MAX_COMPLEXITY);
  });
});
