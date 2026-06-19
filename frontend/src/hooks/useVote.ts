'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { submitVote, AlreadyVotedError } from '../services/api';
import type { Proposal } from '../types';

export interface UseVoteVariables {
  proposalId: string;
  voter: string;
  vote: 'for' | 'against' | 'abstain';
}

export interface UseVoteResult {
  vote: (vars: UseVoteVariables) => void;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  isSuccess: boolean;
  isAlreadyVoted: boolean;
  reset: () => void;
}

export function useVote(): UseVoteResult {
  const queryClient = useQueryClient();

  const mutation = useMutation<Proposal, Error, UseVoteVariables>({
    mutationFn: ({ proposalId, voter, vote }) => submitVote(proposalId, voter, vote),
    onMutate: async ({ proposalId, vote }) => {
      await queryClient.cancelQueries({ queryKey: ['proposals'] });
      const previousData = queryClient.getQueryData(['proposals']);

      queryClient.setQueriesData<{ proposals: Proposal[] }>(
        { queryKey: ['proposals'] },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            proposals: old.proposals.map((p) =>
              p.id === proposalId
                ? {
                    ...p,
                    votesFor: vote === 'for' ? p.votesFor + 1 : p.votesFor,
                    votesAgainst: vote === 'against' ? p.votesAgainst + 1 : p.votesAgainst,
                    votesAbstain: vote === 'abstain' ? p.votesAbstain + 1 : p.votesAbstain,
                  }
                : p,
            ),
          };
        },
      );

      return { previousData };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['proposals'], context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['proposals'] });
    },
  });

  const isAlreadyVoted = mutation.error instanceof AlreadyVotedError;

  return {
    vote: mutation.mutate,
    isLoading: mutation.isPending,
    isError: mutation.isError,
    error: mutation.error,
    isSuccess: mutation.isSuccess,
    isAlreadyVoted,
    reset: mutation.reset,
  };
}
