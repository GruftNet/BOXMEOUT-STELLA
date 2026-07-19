import {
  execute,
  parse,
  validate,
  type ExecutionResult,
  type GraphQLSchema,
} from 'graphql';
import { assertQueryComplexity, isIntrospectionDocument } from './complexity';
import { buildContext, type GraphQLContext } from './context';
import { assertGraphQLRateLimit } from './rateLimit';
import type { Request } from 'express';

export interface ExecuteGraphQLOptions {
  schema: GraphQLSchema;
  query: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
  req?: Request;
  context?: GraphQLContext;
  skipRateLimit?: boolean;
  maxComplexity?: number;
  maxDepth?: number;
}

/**
 * Parse → rate-limit → complexity → validate → execute for a GraphQL HTTP request.
 */
export async function executeGraphQL(
  options: ExecuteGraphQLOptions,
): Promise<ExecutionResult> {
  const document = parse(options.query);
  const context = options.context ?? buildContext(options.req);

  if (!options.skipRateLimit && !isIntrospectionDocument(document)) {
    await assertGraphQLRateLimit(context.identity);
  }

  if (!isIntrospectionDocument(document)) {
    assertQueryComplexity(document, {
      maxComplexity: options.maxComplexity,
      maxDepth: options.maxDepth,
    });
  }

  const errors = validate(options.schema, document);
  if (errors.length > 0) {
    return { errors };
  }

  return execute({
    schema: options.schema,
    document,
    variableValues: options.variables ?? undefined,
    operationName: options.operationName ?? undefined,
    contextValue: context,
  });
}
