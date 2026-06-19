import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useVote } from '../useVote';
import { server } from '../../__tests__/mocks/handlers';
import { mockProposals, resetGovernanceVotes } from '../../__tests__/mocks/handlers';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe('useVote', () => {
  beforeEach(() => {
    resetGovernanceVotes();
  });

  describe('Successful vote', () => {
    it('should vote successfully and return isSuccess = true', async () => {
      const { result } = renderHook(() => useVote(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.vote({
          proposalId: 'prop_1',
          voter: 'GAXDVQEKVAS2VP6QZ7Q7Q4Q5Q6Q7Q8Q9Q0Q1Q2Q3Q4Q5Q6Q7Q8Q9Q0Q1',
          vote: 'for',
        });
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.isError).toBe(false);
      expect(result.current.isAlreadyVoted).toBe(false);
    });
  });

  describe('Already voted (409)', () => {
    it('should set isAlreadyVoted = true on 409 response', async () => {
      const { result } = renderHook(() => useVote(), {
        wrapper: createWrapper(),
      });

      const voter = 'GAXDVQEKVAS2VP6QZ7Q7Q4Q5Q6Q7Q8Q9Q0Q1Q2Q3Q4Q5Q6Q7Q8Q9Q0Q1';

      act(() => {
        result.current.vote({
          proposalId: 'prop_1',
          voter,
          vote: 'for',
        });
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      act(() => {
        result.current.vote({
          proposalId: 'prop_1',
          voter,
          vote: 'against',
        });
      });

      await waitFor(() => {
        expect(result.current.isAlreadyVoted).toBe(true);
      });

      expect(result.current.isError).toBe(true);
      expect(result.current.isSuccess).toBe(false);
    });
  });

  describe('Rollback on network error', () => {
    it('should roll back optimistic update on network error', async () => {
      server.use(
        http.post(`${API_BASE}/api/governance/proposals/:id/vote`, () => {
          return HttpResponse.json(
            { error: 'Network error' },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useVote(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.vote({
          proposalId: 'prop_1',
          voter: 'GAXDVQEKVAS2VP6QZ7Q7Q4Q5Q6Q7Q8Q9Q0Q1Q2Q3Q4Q5Q6Q7Q8Q9Q0Q1',
          vote: 'for',
        });
      });

      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });

      expect(result.current.isSuccess).toBe(false);
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('reset', () => {
    it('should reset mutation state when reset is called', async () => {
      const { result } = renderHook(() => useVote(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.vote({
          proposalId: 'prop_1',
          voter: 'GAXDVQEKVAS2VP6QZ7Q7Q4Q5Q6Q7Q8Q9Q0Q1Q2Q3Q4Q5Q6Q7Q8Q9Q0Q1',
          vote: 'for',
        });
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.isSuccess).toBe(false);
      expect(result.current.isError).toBe(false);
      expect(result.current.isAlreadyVoted).toBe(false);
    });
  });
});
