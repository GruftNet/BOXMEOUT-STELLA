'use client';

// ============================================================
// BOXMEOUT — CountdownTimer Component
// ============================================================

import { useMarketCountdown } from '../../hooks/useMarketCountdown';

interface CountdownTimerProps {
  /** ISO 8601 timestamp of target time */
  targetDate: string;
  /** Optional label for context (e.g. "Betting closes in") */
  label?: string;
}

export function CountdownTimer({ targetDate, label }: CountdownTimerProps): JSX.Element {
  const countdown = useMarketCountdown(targetDate);

  return (
    <span className="text-sm text-gray-200">
      {label && <span className="text-gray-400 mr-1">{label}</span>}
      <span className="font-mono text-amber-400">{countdown}</span>
    </span>
  );
}
