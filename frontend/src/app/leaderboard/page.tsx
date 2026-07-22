import { Suspense } from 'react';
import LeaderboardContent from './LeaderboardContent';

export default function LeaderboardPage(): JSX.Element {
  return (
    <Suspense fallback={<main className="max-w-4xl mx-auto px-4 py-6"><div className="text-gray-400">Loading…</div></main>}>
      <LeaderboardContent />
    </Suspense>
  );
}
