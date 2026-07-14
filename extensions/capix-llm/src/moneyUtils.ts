/**
 * Integer minor-unit money helpers.
 *
 * All currency amounts are kept in BigInt or integer minor units and only
 * converted to a display string at the very end, avoiding the cumulative
 * rounding errors inherent in floating-point arithmetic.
 */

/**
 * Convert an integer minor-unit string (e.g. lamports, micro-USDC) into a
 * display string using BigInt arithmetic.  The input is the raw integer
 * from the API; the output is a human-readable decimal string.
 *
 * @param amountStr raw integer string from the API (e.g. "1234567890")
 * @param scale     minor units per whole unit (9 for SOL lamports, 6 for USDC)
 * @param decimals  how many fractional digits to show (default 2)
 */
export function minorToDisplay(amountStr: string, scale: number, decimals = 2): string {
  const amount = BigInt(amountStr || "0");
  const divisor = 10n ** BigInt(scale);
  const whole = amount / divisor;
  const frac = amount % divisor;
  const fracStr = frac.toString().padStart(scale, "0").slice(0, decimals);
  return `${whole}.${fracStr}`;
}

/**
 * Sum a list of minor-unit amounts that may use different scales into a
 * single normalized BigInt total plus the scale it was normalized to.
 */
export function sumMinor(entries: Array<{ amount: string; scale: number }>): { amount: bigint; scale: number } {
  const maxScale = entries.reduce((max, e) => Math.max(max, e.scale || 0), 0);
  let total = 0n;
  for (const e of entries) {
    const s = e.scale || 0;
    const normalized = BigInt(e.amount || "0") * (10n ** BigInt(maxScale - s));
    total += normalized;
  }
  return { amount: total, scale: maxScale };
}

/**
 * Convert a dollar float into integer micro-units (1/10 000 of a dollar).
 * Scale-4 keeps enough precision for per-minute rates shown to 4 decimal
 * places while keeping all subsequent arithmetic in plain integers.
 */
export function dollarsToMicro(dollars: number): number {
  return Math.round((dollars || 0) * 10000);
}

/**
 * Convert integer micro-units (1/10 000 dollar) to a display string.
 *
 * @param micro     integer micro-dollar amount
 * @param decimals  fractional decimal places to show (2 or 4)
 */
export function microToDisplay(micro: number, decimals = 2): string {
  const v = Math.round(micro);
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const whole = Math.trunc(abs / 10000);
  const frac = abs % 10000;
  const fracStr = frac.toString().padStart(4, "0").slice(0, decimals);
  return `${sign}${whole}.${fracStr}`;
}
