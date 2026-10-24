/** Display helpers shared by the status tiles and the latency chart. */

// Latency is stored in whole microseconds. Show µs for normal values and
// switch to ms once it's large enough that µs digits stop being readable.
export function formatLatency(us: number | null): string {
  if (us === null) return '—';
  if (us < 1000) return `${us} µs`;
  return `${(us / 1000).toFixed(1)} ms`;
}

export function formatRate(n: number | null): string {
  if (n === null) return '—';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
