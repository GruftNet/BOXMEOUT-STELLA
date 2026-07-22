/**
 * Unit tests for useLeaderboard hook using @testing-library/react and MSW.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { useLeaderboard } from '../useLeaderboard';
import { server, mockLeaderboard } from '../../__tests__/mocks/handlers';
import { http, HttpResponse } from 'msw';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

function createWrapper(): ({ children }: { children: ReactNode }) => JSX.Element {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useLeaderboard', () => {
  describe('successful fetch', () => {
    it('should return entries after successful fetch', async () => {
      const { result } = renderHook(() => useLeaderboard('won'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.entries).toHaveLength(mockLeaderboard.length);
      expect(result.current.entries[0].rank).toBe(1);
      expect(result.current.error).toBeNull();
    });

    it('should sort by total_won_xlm when metric is won', async () => {
      const { result } = renderHook(() => useLeaderboard('won'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const sorted = [...result.current.entries].sort((a, b) => b.total_won_xlm - a.total_won_xlm);
      expect(result.current.entries.map((e) => e.total_won_xlm)).toEqual(
        sorted.map((e) => e.total_won_xlm),
      );
    });
  });

  describe('empty state', () => {
    it('should return empty entries array when API returns empty', async () => {
      server.use(
        http.get(`${API_BASE}/api/leaderboard`, () => {
          return HttpResponse.json([]);
        }),
      );

      const { result } = renderHook(() => useLeaderboard('won'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.entries).toEqual([]);
      expect(result.current.error).toBeNull();
    });
  });

  describe('error state', () => {
    it('should set error on network failure', async () => {
      server.use(
        http.get(`${API_BASE}/api/leaderboard`, () => {
          return HttpResponse.json({ error: 'Server Error' }, { status: 500 });
        }),
      );

      const { result } = renderHook(() => useLeaderboard('won'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });

      expect(result.current.entries).toEqual([]);
    });
  });

  describe('tab switching with correct metric param', () => {
    it('should pass metric=bets when metric is bets', async () => {
      let capturedMetric = '';
      server.use(
        http.get(`${API_BASE}/api/leaderboard`, ({ request }) => {
          const url = new URL(request.url);
          capturedMetric = url.searchParams.get('metric') ?? '';
          return HttpResponse.json(mockLeaderboard);
        }),
      );

      const { result } = renderHook(() => useLeaderboard('bets'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(capturedMetric).toBe('bets');
    });

    it('should pass metric=winrate when metric is winrate', async () => {
      let capturedMetric = '';
      server.use(
        http.get(`${API_BASE}/api/leaderboard`, ({ request }) => {
          const url = new URL(request.url);
          capturedMetric = url.searchParams.get('metric') ?? '';
          return HttpResponse.json(mockLeaderboard);
        }),
      );

      const { result } = renderHook(() => useLeaderboard('winrate'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(capturedMetric).toBe('winrate');
    });
  });
});
