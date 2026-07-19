export function encodeCursor(marketId: string, scheduledAt: Date | string): string {
  const ts = scheduledAt instanceof Date ? scheduledAt.toISOString() : scheduledAt;
  return Buffer.from(`${ts}|${marketId}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { scheduledAt: string; marketId: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = raw.indexOf('|');
  if (sep <= 0) {
    throw new Error('Invalid cursor');
  }
  return {
    scheduledAt: raw.slice(0, sep),
    marketId: raw.slice(sep + 1),
  };
}
