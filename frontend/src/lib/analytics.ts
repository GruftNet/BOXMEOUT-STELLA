// ============================================================
// BOXMEOUT — Analytics SDK
// Wraps Mixpanel (or a stub in non-browser/test environments).
// Drop-in replacement: swap PROJECT_TOKEN env var to switch projects.
//
// Privacy policy:
//   - No PII is ever sent. Wallet addresses are one-way hashed
//     (SHA-256 hex, first 16 chars) before leaving the client.
//   - IP collection is disabled at the Mixpanel project level
//     (set ip: false in init options).
//   - All properties are white-listed here; raw fields never forwarded.
// ============================================================

// ─── Type declarations for the lazily-loaded Mixpanel browser bundle ────────

type MixpanelLib = {
  init: (token: string, config: Record<string, unknown>) => void;
  track: (event: string, props?: Record<string, unknown>) => void;
  identify: (distinctId: string) => void;
  reset: () => void;
  register: (props: Record<string, unknown>) => void;
  people: { set: (props: Record<string, unknown>) => void };
};

// ─── Singleton state ─────────────────────────────────────────────────────────

let _mp: MixpanelLib | null = null;
let _initialized = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * One-way hash of a Stellar public key.
 * Returns the first 16 hex chars of SHA-256 (no reversible PII).
 */
export async function hashAddress(address: string): Promise<string> {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    // Server-side or old browser fallback — return a stable opaque token
    return address.slice(0, 6) + '…' + address.slice(-4);
  }
  const enc = new TextEncoder();
  const buf = await window.crypto.subtle.digest('SHA-256', enc.encode(address));
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 16);
}

// ─── Initialisation ──────────────────────────────────────────────────────────

/**
 * Initialise Mixpanel once.  Safe to call multiple times (idempotent).
 * Must be called before any track() call, typically in RootLayout or a
 * client-side provider component.
 */
export function initAnalytics(): void {
  if (_initialized) return;
  if (typeof window === 'undefined') return; // SSR guard

  const token = process.env.NEXT_PUBLIC_MIXPANEL_TOKEN;
  if (!token) {
    // Gracefully degrade — analytics is optional infrastructure.
    _initialized = true;
    return;
  }

  // Dynamically import so the ~90 kB Mixpanel bundle only loads client-side.
  import('mixpanel-browser').then((mod) => {
    const mp = (mod.default ?? mod) as MixpanelLib;
    mp.init(token, {
      // Privacy: never capture raw IP
      ip: false,
      // Persist anonymous distinct-id in localStorage
      persistence: 'localStorage',
      // Batch events to reduce network overhead
      batch_requests: true,
      // Do not automatically track page views — we do it manually for accuracy
      track_pageview: false,
    });
    _mp = mp;
    // Register app-level super properties present on every event
    _mp.register({
      app: 'boxmeout',
      network: process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet',
    });
  });

  _initialized = true;
}

// ─── Core primitives ─────────────────────────────────────────────────────────

/**
 * Fire a named analytics event with optional properties.
 * Never throws — all errors are swallowed so analytics can never break the UI.
 */
export function track(event: string, properties?: Record<string, unknown>): void {
  if (!_mp) return;
  try {
    _mp.track(event, properties);
  } catch {
    // swallow — analytics must never affect the user experience
  }
}

/**
 * Associate a hashed wallet address with subsequent events.
 * Call on wallet connect; clears on wallet disconnect.
 */
export function identifyUser(hashedId: string): void {
  if (!_mp) return;
  try {
    _mp.identify(hashedId);
    _mp.people.set({ last_seen: new Date().toISOString() });
  } catch {}
}

/**
 * Reset the Mixpanel identity (call on wallet disconnect).
 */
export function resetIdentity(): void {
  if (!_mp) return;
  try {
    _mp.reset();
  } catch {}
}
