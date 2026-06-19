'use client';

import { useQuery } from '@tanstack/react-query';
import type { LeaderboardEntry } from '../types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export type LeaderboardMetric = 'won' | 'bets' | 'winrate';

export interface UseLeaderboardResult {
  entries: LeaderboardEntry[];
  isLoading: boolean;
  error: Error | null;
}

async function fetchLeaderboard(metric: LeaderboardMetric, limit: number = 50): Promise<LeaderboardEntry[]> {
  const res = await fetch(`${API_BASE}/api/leaderboard?metric=${metric}&limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch leaderboard');
  return res.json() as Promise<LeaderboardEntry[]>;
}

export function useLeaderboard(metric: LeaderboardMetric, limit: number = 50): UseLeaderboardResult {
  const { data, isLoading, error } = useQuery<LeaderboardEntry[], Error>({
    queryKey: ['leaderboard', metric, limit],
    queryFn: () => fetchLeaderboard(metric, limit),
    staleTime: 60_000,
  });

  return {
    entries: data ?? [],
    isLoading,
    error: error ?? null,
  };
}
