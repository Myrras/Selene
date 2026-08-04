/** Duration formatting for the results status bar (live timer + final time). */

/** `842 ms` · `2.4 s` · `1m 05s` — readable at every magnitude a query can take. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms).toLocaleString()} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
