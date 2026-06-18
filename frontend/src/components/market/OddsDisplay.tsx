// ============================================================
// BOXMEOUT — OddsDisplay Component
// Shows LMSR-derived implied probabilities and payout multipliers.
// Odds are computed on the server via getMarketOdds() and passed in
// as basis points (0..10000). This component only renders.
// ============================================================

interface OddsDisplayProps {
  /** LMSR implied probability for FighterA in basis points (0..10000). */
  odds_a: number;
  /** LMSR implied probability for FighterB in basis points (0..10000). */
  odds_b: number;
  /** LMSR implied probability for Draw in basis points (0..10000). */
  odds_draw: number;
  /** Platform fee in basis points used to compute payout multiplier. */
  fee_bps: number;
  fighter_a: string;
  fighter_b: string;
}

interface OutcomeRow {
  label: string;
  odds_bps: number;
  color: string;
}

/**
 * Payout multiplier ≈ (1 - fee) / p_i.
 * Returns null when price is zero (no bets yet on that side).
 */
function multiplier(odds_bps: number, fee_bps: number): number | null {
  if (odds_bps <= 0) return null;
  return (10000 - fee_bps) / odds_bps;
}

export function OddsDisplay({
  odds_a,
  odds_b,
  odds_draw,
  fee_bps,
  fighter_a,
  fighter_b,
}: Readonly<OddsDisplayProps>): JSX.Element {
  const outcomes: OutcomeRow[] = [
    { label: fighter_a, odds_bps: odds_a,    color: 'text-red-400'  },
    { label: 'Draw',    odds_bps: odds_draw, color: 'text-gray-400' },
    { label: fighter_b, odds_bps: odds_b,    color: 'text-blue-400' },
  ];

  const maxOdds = Math.max(odds_a, odds_b, odds_draw);
  const hasBets = maxOdds > 0;

  return (
    <div className="flex gap-2">
      {outcomes.map(({ label, odds_bps, color }) => {
        const mult = multiplier(odds_bps, fee_bps);
        // Implied probability shown as percent, e.g. 3333 bps → "33%"
        const impliedPct = odds_bps > 0 ? (odds_bps / 100).toFixed(0) : null;
        // Favorite = highest LMSR implied probability (most bets)
        const isFavorite = hasBets && odds_bps === maxOdds;

        return (
          <div
            key={label}
            className={`flex-1 flex flex-col items-center rounded-lg py-2 px-1 transition-colors ${
              isFavorite ? 'bg-gray-700 ring-1 ring-amber-500/60' : 'bg-gray-800'
            }`}
          >
            <span className="text-gray-400 text-xs truncate w-full text-center mb-1">{label}</span>
            <span className={`font-bold text-sm transition-all duration-300 ${color}`}>
              {mult === null ? '—' : `${mult.toFixed(2)}x`}
            </span>
            <span className="text-gray-500 text-xs mt-0.5">
              {impliedPct === null ? '—' : `${impliedPct}%`}
            </span>
            {isFavorite && (
              <span className="text-amber-400 text-[10px] mt-0.5 font-medium">FAV</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
