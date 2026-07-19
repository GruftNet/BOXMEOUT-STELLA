import {
  GraphQLError,
  Kind,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';

export const DEFAULT_MAX_COMPLEXITY = 1_000;
export const DEFAULT_MAX_DEPTH = 10;

const LIST_MULTIPLIER = 10;

export interface ComplexityOptions {
  maxComplexity?: number;
  maxDepth?: number;
}

/**
 * Lightweight query complexity / depth guard.
 * Each field costs 1; list-shaped fields multiply child cost by LIST_MULTIPLIER.
 */
export function assertQueryComplexity(
  document: DocumentNode,
  options: ComplexityOptions = {},
): { complexity: number; depth: number } {
  const maxComplexity = options.maxComplexity ?? DEFAULT_MAX_COMPLEXITY;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(def.name.value, def);
    }
  }

  let complexity = 0;
  let depth = 0;

  for (const def of document.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    const result = scoreSelection(def.selectionSet, fragments, 1, 1);
    complexity += result.complexity;
    depth = Math.max(depth, result.depth);
  }

  if (depth > maxDepth) {
    throw new GraphQLError(`Query depth ${depth} exceeds maximum of ${maxDepth}`, {
      extensions: { code: 'QUERY_DEPTH_EXCEEDED', depth, maxDepth },
    });
  }

  if (complexity > maxComplexity) {
    throw new GraphQLError(
      `Query complexity ${complexity} exceeds maximum of ${maxComplexity}`,
      {
        extensions: { code: 'QUERY_COMPLEXITY_EXCEEDED', complexity, maxComplexity },
      },
    );
  }

  return { complexity, depth };
}

function scoreSelection(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  depth: number,
  multiplier: number,
): { complexity: number; depth: number } {
  let complexity = 0;
  let maxDepth = depth;

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const field = selection as FieldNode;
      if (field.name.value === '__typename') continue;

      complexity += 1 * multiplier;
      const childMultiplier = isListField(field) ? multiplier * LIST_MULTIPLIER : multiplier;

      if (field.selectionSet) {
        const child = scoreSelection(field.selectionSet, fragments, depth + 1, childMultiplier);
        complexity += child.complexity;
        maxDepth = Math.max(maxDepth, child.depth);
      }
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const frag = fragments.get(selection.name.value);
      if (frag) {
        const child = scoreSelection(frag.selectionSet, fragments, depth, multiplier);
        complexity += child.complexity;
        maxDepth = Math.max(maxDepth, child.depth);
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT && selection.selectionSet) {
      const child = scoreSelection(selection.selectionSet, fragments, depth, multiplier);
      complexity += child.complexity;
      maxDepth = Math.max(maxDepth, child.depth);
    }
  }

  return { complexity, depth: maxDepth };
}

function isListField(field: FieldNode): boolean {
  const name = field.name.value;
  return (
    name === 'markets' ||
    name === 'bets' ||
    name === 'positions' ||
    name === 'trades' ||
    name === 'edges' ||
    name === 'activeBets' ||
    name === 'pastBets' ||
    name === 'pendingClaims'
  );
}

/** Introspection / schema probe ops are exempt from complexity limits. */
export function isIntrospectionDocument(document: DocumentNode): boolean {
  for (const def of document.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    const op = def as OperationDefinitionNode;
    for (const sel of op.selectionSet.selections) {
      if (sel.kind === Kind.FIELD && (sel.name.value === '__schema' || sel.name.value === '__type')) {
        return true;
      }
    }
  }
  return false;
}
