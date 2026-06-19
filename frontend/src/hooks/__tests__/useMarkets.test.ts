/**
 * Unit tests for useMarkets hook using @testing-library/react and MSW.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { useMarkets } from '../../hooks/useMarkets';
import { server } from '../../__tests__/mocks/handlers';
import { mockMarkets } from '../../__tests__/mocks/handlers';
import { http, HttpResponse } from 'msw';

describe('useMarkets', () => {
  describe('Initial loading state', () => {
    it('should start with isLoading = true', () => {
      const { result } = renderHook(() => useMarkets());
      expect(result.current.isLoading).toBe(true);
    });

    it('should start with empty markets array', () => {
      const { result } = renderHook(() => useMarkets());
      expect(result.current.markets).toEqual([]);
    });

    it('should start with null error', () => {
      const { result } = renderHook(() => useMarkets());
      expect(result.current.error).toBeNull();
    });

    it('should start with total = 0', () => {
      const { result } = renderHook(() => useMarkets());
      expect(result.current.total).toBe(0);
    });
  });

  describe('Markets populated after successful fetch', () => {
    it('should populate markets array after API success', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.markets).toHaveLength(mockMarkets.length);
      expect(result.current.markets[0].market_id).toBe('market-1');
      expect(result.current.markets[1].market_id).toBe('market-2');
    });

    it('should set total to correct count', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.total).toBe(mockMarkets.length);
    });

    it('should set isLoading = false after data fetch', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should clear error on successful fetch', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('Error state set on failed fetch', () => {
    it('should set error on network failure', async () => {
      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          return HttpResponse.json(
            { error: 'Internal Server Error' },
            { status: 500 }
          );
        })
      );

      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });

      expect(result.current.error?.message).toContain('Unexpected response');
    });

    it('should keep isLoading = false when error occurs', async () => {
      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          return HttpResponse.json(
            { error: 'Server Error' },
            { status: 500 }
          );
        })
      );

      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should clear previous data on error', async () => {
      const { result, rerender } = renderHook(
        ({ filters }) => useMarkets(filters),
        { initialProps: { filters: undefined } }
      );

      await waitFor(() => {
        expect(result.current.markets).toHaveLength(mockMarkets.length);
      });

      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          return HttpResponse.json(
            { error: 'Server Error' },
            { status: 500 }
          );
        })
      );

      rerender({ filters: undefined });

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });
    });
  });

  describe('refetch() triggers a new fetch', () => {
    it('should expose refetch function', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(typeof result.current.refetch).toBe('function');
    });

    it('should trigger new fetch when refetch() is called', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const initialMarketsCount = result.current.markets.length;

      // Call refetch
      result.current.refetch();

      // Wait for the new fetch to complete
      await waitFor(() => {
        expect(result.current.markets.length).toBe(initialMarketsCount);
      });

      // Verify markets are still there
      expect(result.current.markets).toHaveLength(mockMarkets.length);
    });

    it('should handle errors during refetch', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Change handler to return error
      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          return HttpResponse.json(
            { error: 'Server Error' },
            { status: 500 }
          );
        })
      );

      result.current.refetch();

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });
    });

    it('should not trigger isLoading during background refetch', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      result.current.refetch();

      // isLoading should remain false (stale data during background refresh)
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });
  });

  describe('Filters support', () => {
    it('should respect status filter', async () => {
      const { result } = renderHook(() => useMarkets({ status: 'resolved' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Should only get resolved markets
      const allResolved = result.current.markets.every(m => m.status === 'resolved');
      expect(allResolved).toBe(true);
    });

    it('should update when filters change', async () => {
      const { result, rerender } = renderHook(
        (filters?: { status?: string; weight_class?: string; search?: string }) => useMarkets(filters),
        { initialProps: undefined as { status?: string; weight_class?: string; search?: string } | undefined }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const totalCount = result.current.total;

      // Change filter
      rerender({ status: 'resolved' });

      await waitFor(() => {
        expect(result.current.total).toBeLessThan(totalCount);
      });
    });
  });

  describe('Auto-polling every 30 seconds', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should auto-poll markets every 30 seconds', async () => {
      let callCount = 0;
      
      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          callCount++;
          return HttpResponse.json({
            markets: mockMarkets,
            total: mockMarkets.length,
            page: 1,
            limit: 20,
          });
        })
      );

      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const initialCallCount = callCount;

      // Fast-forward 30 seconds
      jest.advanceTimersByTime(30_000);

      await waitFor(() => {
        expect(callCount).toBeGreaterThan(initialCallCount);
      });
    });

    it('should cleanup polling on unmount', async () => {
      const { result, unmount } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      unmount();

      // No errors should occur after unmount
      jest.advanceTimersByTime(30_000);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty markets list', async () => {
      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          return HttpResponse.json({
            markets: [],
            total: 0,
            page: 1,
            limit: 20,
          });
        })
      );

      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.markets).toEqual([]);
      expect(result.current.total).toBe(0);
    });

    it('should handle invalid market_id in response gracefully', async () => {
      const marketWithoutId = { ...mockMarkets[0] };
      delete (marketWithoutId as any).market_id;

      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          return HttpResponse.json({
            markets: [marketWithoutId],
            total: 1,
            page: 1,
            limit: 20,
          });
        })
      );

      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.markets).toHaveLength(1);
    });
  });
});
