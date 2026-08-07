/**
 * Builds a safe case-insensitive "contains" regex from user-typed search text.
 *
 * Handing raw input to `new RegExp()` lets a search box take the whole server down: Node runs
 * on a single thread, so one pattern with catastrophic backtracking (`(a+)+$` and friends)
 * blocks every other request for as long as it spins. Escaping every metacharacter reduces
 * the pattern to a literal substring match, which is all the search boxes ever meant to do.
 *
 * Lives here rather than inline because orders.ts escaped its input and staff.ts didn't —
 * exactly the drift a shared helper prevents.
 */

const MAX_SEARCH_LENGTH = 100;

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildSearchRegex(input: unknown): RegExp | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().slice(0, MAX_SEARCH_LENGTH);
  if (!trimmed) return null;
  return new RegExp(escapeRegex(trimmed), 'i');
}
