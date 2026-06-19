'use client';

import type { LeaderboardEntry } from '../../types';

function abbreviateAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function rankBadge(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

export function LeaderboardRow({ entry }: { entry: LeaderboardEntry }): JSX.Element {
  return (
    <div className="flex items-center gap-3 bg-gray-900 rounded-xl px-4 py-3">
      <span className="w-10 text-center text-sm font-bold text-gray-300">
        {rankBadge(entry.rank)}
      </span>
      <span className="font-mono text-sm text-white w-28 truncate">
        {abbreviateAddress(entry.bettor_address)}
      </span>
      <div className="flex flex-1 gap-4 text-sm text-gray-300">
        <span className="w-24 text-right">{entry.total_staked_xlm.toFixed(2)} XLM</span>
        <span className="w-24 text-right">{entry.total_won_xlm.toFixed(2)} XLM</span>
        <span className="w-20 text-right">{entry.bet_count}</span>
        <span className="w-20 text-right font-semibold text-amber-400">
          {entry.win_rate.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

export function LeaderboardRowSkeleton(): JSX.Element {
  return (
    <div className="flex items-center gap-3 bg-gray-900 rounded-xl px-4 py-3 animate-pulse">
      <div className="w-10 h-4 bg-gray-700 rounded" />
      <div className="w-28 h-4 bg-gray-700 rounded" />
      <div className="flex flex-1 gap-4">
        <div className="w-24 h-4 bg-gray-700 rounded" />
        <div className="w-24 h-4 bg-gray-700 rounded" />
        <div className="w-20 h-4 bg-gray-700 rounded" />
        <div className="w-20 h-4 bg-gray-700 rounded" />
      </div>
    </div>
  );
}
