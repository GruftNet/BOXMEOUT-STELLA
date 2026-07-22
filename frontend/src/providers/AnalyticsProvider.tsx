'use client';

// ============================================================
// BOXMEOUT — AnalyticsProvider
// Initialises the analytics SDK once on mount and fires a
// page_viewed event on every Next.js client-side navigation.
// Mount this inside RootLayout, *inside* QueryProvider so hooks work.
//
// useSearchParams() is wrapped in Suspense as required by Next.js 14
// to avoid prerender errors during static generation.
// ============================================================

import { useEffect, ReactNode, Suspense } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { initAnalytics } from '../lib/analytics';
import { trackAppBooted, trackPageView } from '../services/analytics.service';
import { useAnalytics } from '../hooks/useAnalytics';

interface AnalyticsProviderProps {
  children: ReactNode;
}

function AnalyticsInit(): null {
  // Bind identity to current wallet (handled inside useAnalytics)
  useAnalytics();

  const pathname = usePathname();
  const searchParams = useSearchParams();

  // One-time boot
  useEffect(() => {
    initAnalytics();
    trackAppBooted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Page-view tracking on navigation
  useEffect(() => {
    if (!pathname) return;
    trackPageView(pathname, {
      search: searchParams?.toString() ?? '',
    });
  }, [pathname, searchParams]);

  return null;
}

export function AnalyticsProvider({ children }: AnalyticsProviderProps): JSX.Element {
  return (
    <>
      <Suspense fallback={null}>
        <AnalyticsInit />
      </Suspense>
      {children}
    </>
  );
}
