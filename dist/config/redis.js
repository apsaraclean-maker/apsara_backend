import { Redis } from 'ioredis';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
/**
 * Redis is optional in development and required in production.
 *
 * When it's absent the app degrades deliberately rather than failing: express-session falls
 * back to its in-memory store (server.ts) and the auth-context cache turns itself off
 * (utils/authCache.ts). Both of those decisions are made once at boot, so a missing Redis
 * costs nothing at request time — but ioredis still reconnects in the background forever, and
 * every failed attempt emitted an error line. On a machine with no Redis that produced a new
 * line every couple of seconds, which is most of what you see in a local dev terminal.
 *
 * Two changes below: back off much further between attempts, and collapse the repeats into a
 * single message. Neither weakens production behaviour — a real Redis that drops still gets
 * reconnected to, and the recovery is logged.
 */
export const redisClient = new Redis(redisUrl, {
    // Commands fail after 3 attempts instead of queueing indefinitely, so a caller never hangs
    // waiting on a Redis that isn't coming back.
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    // ioredis defaults to retrying every 2s forever. Backing off to a 30s ceiling keeps
    // reconnection working while cutting the retry rate — and therefore the log noise — by an
    // order of magnitude once it's clear nothing is listening.
    retryStrategy: (times) => Math.min(times * 200, 30_000),
});
// The same connection failure repeated every few seconds is one piece of information, not
// hundreds. Log the first occurrence with something actionable, stay quiet while the
// condition persists, and speak up again when it changes.
let lastErrorMessage = null;
let suppressedCount = 0;
/**
 * ioredis reports a failed connection as an AggregateError wrapping one error per resolved
 * address, and that wrapper's own `message` is just the string "AggregateError" — which is
 * why the previous handler printed a bare "Redis error:" with nothing useful after it.
 * Unwrap it so the log names the actual problem, e.g. "connect ECONNREFUSED 127.0.0.1:6379".
 */
function describe(err) {
    const inner = err?.errors;
    if (Array.isArray(inner) && inner.length) {
        const messages = [...new Set(inner.map((e) => e?.message).filter(Boolean))];
        if (messages.length)
            return messages.join('; ');
    }
    return err.message || String(err);
}
redisClient.on('error', (err) => {
    const message = describe(err);
    if (message === lastErrorMessage) {
        suppressedCount += 1;
        return;
    }
    lastErrorMessage = message;
    suppressedCount = 0;
    console.warn(`[redis] ${message}`);
    console.warn('[redis] continuing without Redis — sessions use the in-memory store and the auth cache is disabled.');
    console.warn('[redis] this is expected locally; set REDIS_URL or start Redis to silence it. Further identical errors suppressed.');
});
redisClient.on('ready', () => {
    if (lastErrorMessage) {
        console.log(`[redis] reconnected (suppressed ${suppressedCount} repeated error(s) while down)`);
        lastErrorMessage = null;
        suppressedCount = 0;
    }
    else {
        console.log('[redis] connected');
    }
});
