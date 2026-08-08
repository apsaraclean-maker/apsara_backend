import { redisClient } from '../config/redis.js';
/**
 * Short-lived cache for the three lookups every authenticated request used to repeat.
 *
 * sessionVerification loaded the user, then the business (sequentially — the business id
 * comes off the user), and then most routes called getAccessibleBranchIds for a third round
 * trip. That's three trips of fixed overhead before a handler ran any query of its own:
 * invisible against a co-located database, but ~120ms added to *every* request once the API
 * and Mongo aren't in the same region. Redis is already in the stack for sessions and sits
 * far closer, so the same answer costs one GET.
 *
 * Correctness rests on eviction, not on the TTL. Everything that changes what a caller may
 * do — role, PIN, active flag, branch assignments, the business being paused — calls the
 * matching invalidate* function below at the point of the write, so those take effect on the
 * next request exactly as they did before. The 60s TTL is only a backstop for changes made
 * outside the app (a direct database edit, say), which is also why it's short.
 *
 * Every function here is fail-open: if Redis is unreachable the caller falls through to the
 * database and the request is merely as slow as it used to be. A cache must never be the
 * reason a login stops working — the server already boots with an in-memory session store
 * when Redis is absent, and this has to survive that same condition.
 */
const TTL_SECONDS = 60;
/**
 * Whether Redis is actually usable. server.ts pings once at boot and calls this with the
 * result — the same check that decides between the Redis and in-memory session stores.
 *
 * Without it, every authenticated request issued Redis commands into the void on a machine
 * with no Redis: each one still has to fail before the caller can fall through to Mongo, and
 * each one logs an error. Local development has no Redis by design (see the fallback note in
 * server.ts), so that was the default experience, not an edge case. When disabled the cache
 * becomes a no-op and every lookup goes straight to the database exactly as it did before
 * the cache existed.
 */
let cacheEnabled = false;
export function setAuthCacheEnabled(enabled) {
    cacheEnabled = enabled;
}
const userKey = (userId) => `authctx:u:${userId}`;
const businessKey = (businessId) => `authctx:b:${businessId}`;
async function readJson(key) {
    if (!cacheEnabled)
        return null;
    try {
        const raw = await redisClient.get(key);
        return raw ? JSON.parse(raw) : null;
    }
    catch {
        return null;
    }
}
async function writeJson(key, value) {
    if (!cacheEnabled)
        return;
    try {
        await redisClient.set(key, JSON.stringify(value), 'EX', TTL_SECONDS);
    }
    catch {
        /* fail-open: the next request just reads through to Mongo again */
    }
}
async function drop(keys) {
    if (!cacheEnabled || !keys.length)
        return;
    try {
        await redisClient.del(...keys);
    }
    catch {
        /* fail-open */
    }
}
export const getCachedUserContext = (userId) => readJson(userKey(userId));
export const setCachedUserContext = (userId, ctx) => writeJson(userKey(userId), ctx);
export const getCachedBusinessContext = (businessId) => readJson(businessKey(businessId));
export const setCachedBusinessContext = (businessId, ctx) => writeJson(businessKey(businessId), ctx);
/**
 * Drop one user's cached context. Call after anything that changes their role, PIN, active
 * state or branch assignments — including the branch-assignment writes that don't go through
 * invalidateUserSessions, since those change what the user can see without ending their
 * session.
 */
export const invalidateUserContext = (userId) => drop([userKey(String(userId))]);
export const invalidateUserContexts = (userIds) => drop(userIds.map((id) => userKey(String(id))));
/** Drop a business's cached status — call when it's paused, blocked or reactivated. */
export const invalidateBusinessContext = (businessId) => drop([businessKey(String(businessId))]);
