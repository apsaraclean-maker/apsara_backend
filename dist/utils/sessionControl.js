import { User, ActiveSession } from '../models.js';
import { invalidateUserContext } from './authCache.js';
/**
 * Kills every session a user holds, on every device, immediately.
 *
 * Call this after any change that must not wait for a session to expire on its own: a role
 * change, a PIN change, or an account being disabled. Without it those changes only take
 * effect on the user's next login, which for a 7-day session cookie is a 7-day window where
 * a demoted user keeps their old access.
 *
 * Three steps, and all three matter:
 *
 *  1. Bump `session_epoch`. This is the actual invalidation — sessionVerification compares
 *     the epoch stamped into each session against the user's current one and rejects any
 *     mismatch. It's atomic and needs no knowledge of which sessions exist, so it can't miss
 *     one and it still holds if the session store is restarted or unreachable.
 *
 *  2. Delete the user's ActiveSession rows. Easy to overlook, and skipping it is worse than
 *     doing nothing: those rows are what enforce the 3-device login limit, so leaving them
 *     behind means the user is bounced out AND then greeted with "device limit reached" when
 *     they try to log back in, with no way to clear it themselves.
 *
 *  3. Best-effort destroy in the session store, purely so Redis doesn't carry dead sessions
 *     until their TTL. Step 1 has already made them unusable, so a failure here is logged
 *     and swallowed rather than failing the caller's request.
 *
 *  4. Evict the cached auth context. sessionVerification reads role/epoch/branches through a
 *     60s Redis cache, so without this step the epoch bump in step 1 would sit invisible
 *     behind a warm cache entry and the revocation wouldn't bite until the entry aged out.
 *     Done first, before the bump, so there is no window in which a concurrent request can
 *     re-prime the cache from the pre-bump database state.
 */
export async function invalidateUserSessions(userId, store) {
    await invalidateUserContext(userId);
    await User.updateOne({ _id: userId }, { $inc: { session_epoch: 1 } });
    // Again after the write: a request racing the bump could have re-primed the cache from the
    // old row between the two statements above.
    await invalidateUserContext(userId);
    const sessions = await ActiveSession.find({ user_id: userId }).select('session_id');
    if (store) {
        await Promise.all(sessions.map((s) => new Promise((resolve) => {
            store.destroy(s.session_id, (err) => {
                if (err)
                    console.error('[sessionControl] store destroy failed (non-fatal):', err.message);
                resolve();
            });
        })));
    }
    await ActiveSession.deleteMany({ user_id: userId });
}
