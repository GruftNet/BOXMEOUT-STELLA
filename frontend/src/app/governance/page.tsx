'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useProposals } from '@/hooks/useProposals';
import { ProposalCardSkeleton } from '@/components/governance/ProposalCardSkeleton';
import type { Proposal, ProposalStatus } from '@/types';

export default function GovernanceList() {
  const [statusFilter, setStatusFilter] = useState<ProposalStatus | 'All'>('All');

  const { proposals, total, isLoading, isError, error } = useProposals({
    status: statusFilter === 'All' ? undefined : statusFilter,
  });

  const filteredProposals = proposals;

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold">Governance</h1>
          <p className="text-gray-400 mt-2">Discover and vote on network proposals</p>
        </div>
        <div className="flex gap-4">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded text-sm font-medium"
          >
            <option value="All">All Proposals</option>
            <option value="Active">Active</option>
            <option value="Passed">Passed</option>
            <option value="Failed">Failed</option>
            <option value="Executed">Executed</option>
          </select>
          <Link
            href="/governance/new"
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium transition-colors"
          >
            New Proposal
          </Link>
        </div>
      </div>

      {isError && (
        <div className="text-center p-8 bg-red-900/20 border border-red-800 rounded-xl mb-6">
          <p className="text-red-400">Failed to load proposals. Please try again.</p>
          {error && <p className="text-red-300 text-sm mt-1">{error.message}</p>}
        </div>
      )}

      <div className="space-y-4">
        {isLoading && filteredProposals.length === 0 ? (
          Array.from({ length: 4 }).map((_, i) => <ProposalCardSkeleton key={i} />)
        ) : filteredProposals.length === 0 ? (
          <div className="text-center p-8 bg-gray-800/50 rounded-xl border border-gray-700">
            <p className="text-gray-400">No proposals found matching this filter.</p>
          </div>
        ) : (
          filteredProposals.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} />
          ))
        )}
      </div>
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;

  const getStatusColor = (status: ProposalStatus) => {
    switch (status) {
      case 'Active': return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      case 'Passed': return 'bg-green-500/10 text-green-400 border-green-500/20';
      case 'Failed': return 'bg-red-500/10 text-red-400 border-red-500/20';
      case 'Executed': return 'bg-purple-500/10 text-purple-400 border-purple-500/20';
      default: return 'bg-gray-500/10 text-gray-400 border-gray-500/20';
    }
  };

  const getTimeRemaining = () => {
    if (proposal.status !== 'Active') return 'Ended';
    const ms = new Date(proposal.expiresAt).getTime() - Date.now();
    if (ms <= 0) return 'Ended';
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    return `${days} day${days !== 1 ? 's' : ''} left`;
  };

  const formatType = (type: string) => {
    return type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  };

  return (
    <Link href={`/governance/${proposal.id}`} className="block">
      <div className="p-5 bg-gray-900 border border-gray-800 rounded-xl hover:border-gray-600 transition-colors">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${getStatusColor(proposal.status)}`}>
                {proposal.status}
              </span>
              <span className="text-sm font-mono text-gray-400">
                {formatType(proposal.type)}
              </span>
            </div>
            <p className="text-gray-200 font-medium mb-3">{proposal.description}</p>
            <div className="flex items-center gap-4 text-sm text-gray-500">
              <span>Proposer: <span className="font-mono">{proposal.proposer}</span></span>
              <span>•</span>
              <span>{totalVotes.toLocaleString()} votes cast</span>
            </div>
          </div>

          <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center">
            <div className="text-sm font-medium text-gray-400 mb-1">
              {getTimeRemaining()}
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <div className="w-2 h-2 rounded-full bg-green-500" title="For" />
              <div className="w-2 h-2 rounded-full bg-red-500" title="Against" />
              <div className="w-2 h-2 rounded-full bg-gray-500" title="Abstain" />
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
