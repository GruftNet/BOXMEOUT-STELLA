// ============================================================
// BOXMEOUT — Home Page (/)
// Lists all boxing markets with filters, sorting, and pagination.
// ============================================================

import { Suspense } from 'react';
import HomePageContent from './HomePageContent';

export default function HomePage(): JSX.Element {
  return (
    <Suspense fallback={<main className="max-w-6xl mx-auto px-4 py-6"><div className="text-gray-400">Loading…</div></main>}>
      <HomePageContent />
    </Suspense>
  );
}
