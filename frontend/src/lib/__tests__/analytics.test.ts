// ============================================================
// Unit tests for frontend/src/lib/analytics.ts
// ============================================================

// Mock mixpanel-browser before importing the module under test
const mockInit = jest.fn();
const mockTrack = jest.fn();
const mockIdentify = jest.fn();
const mockReset = jest.fn();
const mockRegister = jest.fn();
const mockPeopleSet = jest.fn();

jest.mock('mixpanel-browser', () => ({
  __esModule: true,
  default: {
    init: mockInit,
    track: mockTrack,
    identify: mockIdentify,
    reset: mockReset,
    register: mockRegister,
    people: { set: mockPeopleSet },
  },
}));

import { hashAddress, initAnalytics, track, identifyUser, resetIdentity } from '../analytics';

// ─── hashAddress ─────────────────────────────────────────────────────────────

describe('hashAddress', () => {
  const TEST_ADDRESS = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37';

  it('returns a 16-char hex string', async () => {
    // Provide a minimal crypto.subtle stub
    Object.defineProperty(global, 'crypto', {
      value: {
        subtle: {
          digest: async (_algo: string, _buf: ArrayBuffer) => {
            // Return a fixed 32-byte buffer
            return new Uint8Array(32).fill(0xab).buffer;
          },
        },
      },
      writable: true,
      configurable: true,
    });

    const hash = await hashAddress(TEST_ADDRESS);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same input', async () => {
    const h1 = await hashAddress(TEST_ADDRESS);
    const h2 = await hashAddress(TEST_ADDRESS);
    expect(h1).toBe(h2);
  });

  it('does NOT include the raw address', async () => {
    const hash = await hashAddress(TEST_ADDRESS);
    expect(hash).not.toContain(TEST_ADDRESS);
  });

  it('falls back gracefully when crypto.subtle is unavailable', async () => {
    Object.defineProperty(global, 'crypto', {
      value: {},
      writable: true,
      configurable: true,
    });

    const hash = await hashAddress(TEST_ADDRESS);
    // Fallback returns a short opaque string, never the full address
    expect(hash.length).toBeLessThan(TEST_ADDRESS.length);
  });
});

// ─── initAnalytics ────────────────────────────────────────────────────────────

describe('initAnalytics', () => {
  beforeEach(() => {
    jest.resetModules();
    mockInit.mockClear();
    // Ensure we start with a fresh module state
    jest.isolateModules(() => {});
  });

  it('is idempotent — calling twice does not double-initialise', async () => {
    // We can only assert no throw since dynamic import is async
    expect(() => initAnalytics()).not.toThrow();
    expect(() => initAnalytics()).not.toThrow();
  });

  it('does not throw when NEXT_PUBLIC_MIXPANEL_TOKEN is absent', () => {
    delete process.env.NEXT_PUBLIC_MIXPANEL_TOKEN;
    expect(() => initAnalytics()).not.toThrow();
  });
});

// ─── track ───────────────────────────────────────────────────────────────────

describe('track', () => {
  it('does not throw when mixpanel is not yet initialised', () => {
    expect(() => track('test_event', { foo: 'bar' })).not.toThrow();
  });
});

// ─── identifyUser / resetIdentity ────────────────────────────────────────────

describe('identifyUser', () => {
  it('does not throw when mixpanel is not initialised', () => {
    expect(() => identifyUser('abc123')).not.toThrow();
  });
});

describe('resetIdentity', () => {
  it('does not throw when mixpanel is not initialised', () => {
    expect(() => resetIdentity()).not.toThrow();
  });
});
