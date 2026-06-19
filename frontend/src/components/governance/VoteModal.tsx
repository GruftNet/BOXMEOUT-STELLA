'use client';

import { useEffect } from 'react';
import type { Proposal, VoteType } from '@/types';

interface VoteModalProps {
  proposal: Proposal;
  votingPower: number;
  isSubmitting: boolean;
  hasVoted: boolean;
  onVote: (vote: VoteType) => void;
  onClose: () => void;
}

export function VoteModal({
  proposal,
  votingPower,
  isSubmitting,
  hasVoted,
  onVote,
  onClose,
}: VoteModalProps): JSX.Element {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;
  const pctFor = totalVotes > 0 ? (proposal.votesFor / totalVotes) * 100 : 0;
  const pctAgainst = totalVotes > 0 ? (proposal.votesAgainst / totalVotes) * 100 : 0;
  const pctAbstain = totalVotes > 0 ? (proposal.votesAbstain / totalVotes) * 100 : 0;

  const canVote = proposal.status === 'Active' && !hasVoted && !isSubmitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Cast Your Vote</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg">&times;</button>
        </div>

        <p className="text-gray-300 text-sm mb-4">{proposal.description}</p>

        <div className="flex justify-between items-center mb-6 text-sm">
          <span className="text-gray-400">Your Voting Power:</span>
          <span className="font-mono font-medium">{votingPower.toLocaleString()} ILN</span>
        </div>

        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-400 mb-3">Current Results</h3>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-medium text-green-400">For</span>
                <span className="text-gray-400">{proposal.votesFor.toLocaleString()} ({pctFor.toFixed(1)}%)</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div className="h-full bg-green-500 rounded-full" style={{ width: `${pctFor}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-medium text-red-400">Against</span>
                <span className="text-gray-400">{proposal.votesAgainst.toLocaleString()} ({pctAgainst.toFixed(1)}%)</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div className="h-full bg-red-500 rounded-full" style={{ width: `${pctAgainst}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-medium text-gray-400">Abstain</span>
                <span className="text-gray-400">{proposal.votesAbstain.toLocaleString()} ({pctAbstain.toFixed(1)}%)</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div className="h-full bg-gray-500 rounded-full" style={{ width: `${pctAbstain}%` }} />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <button
            onClick={() => onVote('for')}
            disabled={!canVote}
            className="w-full py-2.5 bg-green-500/10 text-green-400 border border-green-500/50 hover:bg-green-500/20 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
          >
            {isSubmitting ? 'Submitting...' : 'Vote For'}
          </button>
          <button
            onClick={() => onVote('against')}
            disabled={!canVote}
            className="w-full py-2.5 bg-red-500/10 text-red-400 border border-red-500/50 hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
          >
            {isSubmitting ? 'Submitting...' : 'Vote Against'}
          </button>
          <button
            onClick={() => onVote('abstain')}
            disabled={!canVote}
            className="w-full py-2.5 bg-gray-500/10 text-gray-400 border border-gray-500/50 hover:bg-gray-500/20 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
          >
            {isSubmitting ? 'Submitting...' : 'Abstain'}
          </button>
        </div>

        {hasVoted && (
          <p className="text-center text-sm text-green-400 mt-4">Your vote has been recorded!</p>
        )}
        {proposal.status !== 'Active' && !hasVoted && (
          <p className="text-center text-sm text-gray-500 mt-4">Voting has ended for this proposal.</p>
        )}
      </div>
    </div>
  );
}
