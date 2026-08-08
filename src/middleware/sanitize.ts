import { Request, Response, NextFunction } from 'express';

/**
 * Rejects request payloads that carry MongoDB query operators in their *keys*.
 *
 * Mongoose casts `{ phone: { $ne: null } }` perfectly happily, so a JSON body of
 * `{"phone": {"$ne": null}}` posted to a login route turns a lookup for one specific account
 * into "any account at all". The same trick reaches query strings, because Express's default
 * parser expands `?status[$ne]=paid` into a nested object.
 *
 * Only keys are inspected — never values. Ordinary text containing `$` or `.` (prices,
 * addresses, notes, order numbers) passes through untouched; a *field name* shaped like an
 * operator does not, and no legitimate client sends one.
 *
 * Rejecting outright rather than silently stripping: stripping quietly changes the meaning of
 * a request, which is both harder to debug and a poor signal when someone is probing.
 *
 * Note on the alternative: Mongoose's global `sanitizeFilter` option is the answer most
 * references give, but it rewrites *every* nested `$` operator into an equality check —
 * including the `$in` / `$ne` / `$gte` this codebase uses throughout orders, dashboard,
 * reports and staff. Enabling it globally would silently break those queries unless each
 * legitimate operator were individually wrapped in `mongoose.trusted()`. Guarding the
 * boundary gets the same protection without that sweep.
 */

const MAX_DEPTH = 12;

function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) return '(payload nested too deeply)';
  if (value === null || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findForbiddenKey(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // `$` starts an operator; a dot lets a key reach into a nested path (and is the vector
    // for the `__proto__`-prefixed dotted-path prototype pollution in Mongoose's update
    // casting, GHSA-664h-wqgq-64gw).
    if (key.startsWith('$') || key.includes('.')) return key;
    const found = findForbiddenKey(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

export function rejectQueryOperators(req: Request, res: Response, next: NextFunction) {
  for (const source of [req.body, req.query, req.params]) {
    const offending = findForbiddenKey(source);
    if (offending) {
      return res.status(400).json({
        code: 'INVALID_INPUT',
        message: `Request contains an unsupported field name: ${offending}`,
      });
    }
  }
  next();
}
