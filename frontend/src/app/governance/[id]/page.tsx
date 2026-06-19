'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getConnectedAddress } from '@/services/wallet';
import { fetchProposalById } from '@/services/api';
import { useVote } from '@/hooks/useVote';
import { VoteModal } from '@/components/governance/VoteModal';
import type { Proposal, VoteType } from '@/types';

export default function ProposalDetail() {
  const params = useParams();
  const id = params.id as string;

  const connectedAddress = getConnectedAddress();

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [votingPower] = useState<number>(15000);
  const [showVoteModal, setShowVoteModal] = useState(false);

  const { vote, isLoading: isVoting, isSuccess, isAlreadyVoted, error: voteError, reset: resetVote } = useVote();

  useEffect(() => {
    if (!id) return;
    setIsLoading(true);
    fetchProposalById(id)
      .then(setProposal)
      .catch(() => setProposal(null))
      .finally(() => setIsLoading(false));
  }, [id]);

  const hasVoted = isSuccess || isAlreadyVoted;

  const handleVote = useCallback(
    (voteType: VoteType) => {
      if (!connectedAddress) return;
      vote({ proposalId: id, voter: connectedAddress, vote: voteType });
    },
    [id, connectedAddress, vote],
  );

  const handleCloseModal = useCallback(() => {
    setShowVoteModal(false);
    resetVote();
  }, [resetVote]);

  useEffect(() => {
    if (isSuccess) {
      const timer = setTimeout(() => {
        setShowVoteModal(false);
        resetVote();
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isSuccess, resetVote]);

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <div className="animate-pulse space-y-6">
          <div className="h-4 w-32 bg-gray-700 rounded" />
          <div className="h-8 w-64 bg-gray-700 rounded" />
          <div className="h-4 w-full bg-gray-700 rounded" />
          <div className="h-4 w-3/4 bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  if (!proposal) {
    return (
      <div className="max-w-4xl mx-auto p-8 text-center">
        <h2 className="text-2xl font-bold text-gray-200 mb-2">Proposal not found</h2>
        <p className="text-gray-400 mb-6">The proposal you are looking for does not exist.</p>
        <Link href="/governance" className="text-blue-500 hover:text-blue-400 font-medium">
          ← Back to Proposals
        </Link>
      </div>
    );
  }

  const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;
  const pctFor = totalVotes > 0 ? (proposal.votesFor / totalVotes) * 100 : 0;
  const pctAgainst = totalVotes > 0 ? (proposal.votesAgainst / totalVotes) * 100 : 0;
  const pctAbstain = totalVotes > 0 ? (proposal.votesAbstain / totalVotes) * 100 : 0;

  const formatType = (type: string) => type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const statusStyles: Record<string, string> = {
    Active: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    Passed: 'bg-green-500/10 text-green-400 border-green-500/20',
    Failed: 'bg-red-500/10 text-red-400 border-red-500/20',
    Executed: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  };

  return (
    <div className="max-w-4xl mx-auto p-8">
      <Link href="/governance" className="text-blue-500 hover:text-blue-400 mb-6 inline-block text-sm font-medium">
        ← Back to Proposals
      </Link>

      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden mb-8">
        <div className="p-6 border-b border-gray-800">
          <div className="flex justify-between items-start mb-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="px-3 py-1 rounded-full text-xs font-semibold bg-gray-800 text-gray-300">
                  {proposal.id}
                </span>
                <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${statusStyles[proposal.status] ?? ''}`}>
                  {proposal.status}
                </span>
              </div>
              <h1 className="text-2xl font-bold">{formatType(proposal.type)}</h1>
            </div>
          </div>

          <div className="bg-gray-800/50 p-4 rounded-lg mb-6 border border-gray-700/50">
            <h3 className="text-sm font-medium text-gray-400 mb-1">Proposed Change</h3>
            <p className="text-lg font-mono text-gray-200">
              Set <span className="text-blue-400">{proposal.type}</span> to <span className="text-green-400">{proposal.value}</span>
            </p>
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-2">Description</h3>
            <p className="text-gray-300 leading-relaxed">{proposal.description}</p>
          </div>
        </div>

        <div className="p-6 bg-gray-900/50">
          <div className="grid md:grid-cols-2 gap-8">
            <div>
              <h3 className="text-lg font-bold mb-4">Current Results</h3>
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium text-green-400">For</span>
                    <span className="text-gray-400">{proposal.votesFor.toLocaleString()} ({pctFor.toFixed(1)}%)</span>
                  </div>
                  <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full bg-green-500 rounded-full" style={{ width: `${pctFor}%` }} />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium text-red-400">Against</span>
                    <span className="text-gray-400">{proposal.votesAgainst.toLocaleString()} ({pctAgainst.toFixed(1)}%)</span>
                  </div>
                  <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full bg-red-500 rounded-full" style={{ width: `${pctAgainst}%` }} />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium text-gray-400">Abstain</span>
                    <span className="text-gray-400">{proposal.votesAbstain.toLocaleString()} ({pctAbstain.toFixed(1)}%)</span>
                  </div>
                  <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full bg-gray-500 rounded-full" style={{ width: `${pctAbstain}%` }} />
                  </div>
                </div>
              </div>
            </div>

            <div className="p-5 border border-gray-800 rounded-xl bg-gray-900">
              <h3 className="text-lg font-bold mb-4">Cast Your Vote</h3>

              {!connectedAddress ? (
                <div className="text-center p-4">
                  <p className="text-sm text-gray-400">Connect wallet to vote.</p>
                </div>
              ) : hasVoted ? (
                <div className="text-center p-4">
                  <p className="text-sm text-green-400">Your vote has been recorded!</p>
                </div>
              ) : proposal.status !== 'Active' ? (
                <div className="text-center p-4">
                  <p className="text-sm text-gray-500">Voting has ended for this proposal.</p>
                </div>
              ) : (
                <>
                  <div className="flex justify-between items-center mb-6 text-sm">
                    <span className="text-gray-400">Your Voting Power:</span>
                    <span className="font-mono font-medium">{votingPower.toLocaleString()} ILN</span>
                  </div>

                  <button
                    onClick={() => setShowVoteModal(true)}
                    className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
                  >
                    Vote Now
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {showVoteModal && proposal && (
        <VoteModal
          proposal={proposal}
          votingPower={votingPower}
          isSubmitting={isVoting}
          hasVoted={hasVoted}
          onVote={handleVote}
          onClose={handleCloseModal}
        />
      )}

      {voteError && !isAlreadyVoted && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm bg-red-900/80 text-white rounded-xl shadow-xl p-4">
          <p className="text-sm font-semibold text-red-400">Vote failed</p>
          <p className="text-xs text-gray-300 mt-1">{voteError.message}</p>
          <button onClick={resetVote} className="text-gray-400 hover:text-white text-sm mt-2">Dismiss</button>
        </div>
      )}
    </div>
  );
}
