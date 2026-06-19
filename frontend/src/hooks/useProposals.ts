'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchProposals } from '../services/api';
import type { Proposal } from '../types';

export interface UseProposalsOptions {
  status?: string;
  page?: number;
  limit?: number;
}

export interface UseProposalsResult {
  proposals: Proposal[];
  total: number;
  page: number;
  limit: number;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useProposals(options?: UseProposalsOptions): UseProposalsResult {
  const queryClient = useQueryClient();
  const { status, page = 1, limit = 20 } = options ?? {};

  const queryKey = ['proposals', { status, page, limit }];

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => fetchProposals({ status, page, limit }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  return {
    proposals: data?.proposals ?? [],
    total: data?.total ?? 0,
    page: data?.page ?? page,
    limit: data?.limit ?? limit,
    isLoading,
    isError,
    error: error as Error | null,
    refetch: () => queryClient.invalidateQueries({ queryKey: ['proposals'] }),
  };
}
