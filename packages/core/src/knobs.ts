/**
 * A numeric env knob that cannot fail open: `Number('')` is 0 and `Number('x')`
 * is NaN, either of which silently disables a cap or stalls every connect.
 */
export function envInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}
