'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { useLeaderboard, type LeaderboardMetric } from '../../hooks/useLeaderboard';
import { LeaderboardRow, LeaderboardRowSkeleton } from '../../components/ui/LeaderboardRow';
import { PlatformStatsBanner } from '../../components/ui/PlatformStatsBanner';

const TABS: { key: LeaderboardMetric; label: string }[] = [
  { key: 'won', label: 'Top Winners' },
  { key: 'bets', label: 'Most Active' },
  { key: 'winrate', label: 'Best Win Rate' },
];

const METRIC_PARAM = 'metric';

export default function LeaderboardPage(): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const metric = (searchParams.get(METRIC_PARAM) as LeaderboardMetric) || 'won';
  const validMetric: LeaderboardMetric = ['won', 'bets', 'winrate'].includes(metric) ? metric : 'won';

  const { entries, isLoading, error } = useLeaderboard(validMetric);

  const setMetric = useCallback(
    (m: LeaderboardMetric) => {
      const params = new URLSearchParams(searchParams.toString());
      if (m === 'won') {
        params.delete(METRIC_PARAM);
      } else {
        params.set(METRIC_PARAM, m);
      }
      router.replace(`/leaderboard${params.toString() ? `?${params.toString()}` : ''}`);
    },
    [router, searchParams],
  );

  return (
    <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-black text-white">Leaderboard</h1>
        <p className="text-gray-400 text-sm mt-1">
          Top bettors ranked by wins, activity, and win rate
        </p>
      </div>

      <PlatformStatsBanner />

      {/* Tab bar */}
      <div className="flex gap-2 border-b border-gray-800 pb-2">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setMetric(key)}
            className={`px-4 py-2 text-sm rounded-lg font-medium transition-colors ${
              validMetric === key
                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <p className="text-red-400 text-sm bg-red-900/20 rounded-lg px-4 py-2">
          Failed to load leaderboard: {error.message}
        </p>
      )}

      {/* Column headers */}
      <div className="flex items-center gap-3 px-4 text-xs text-gray-500 uppercase tracking-wider">
        <span className="w-10 text-center">Rank</span>
        <span className="w-28">Address</span>
        <span className="flex-1 flex gap-4">
          <span className="w-24 text-right">Staked</span>
          <span className="w-24 text-right">Won</span>
          <span className="w-20 text-right">Bets</span>
          <span className="w-20 text-right">Win Rate</span>
        </span>
      </div>

      {/* Rows */}
      <div className="space-y-2">
        {isLoading ? (
          Array.from({ length: 10 }).map((_, i) => <LeaderboardRowSkeleton key={i} />)
        ) : entries.length === 0 ? (
          <p className="text-gray-500 text-center py-16">No leaderboard data yet.</p>
        ) : (
          entries.map((entry) => <LeaderboardRow key={entry.bettor_address} entry={entry} />)
        )}
      </div>
    </main>
  );
}
