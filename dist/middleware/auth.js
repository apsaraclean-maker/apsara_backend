import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { User, Business, UserBranch } from '../models.js';
import { getCachedUserContext, setCachedUserContext, getCachedBusinessContext, setCachedBusinessContext, } from '../utils/authCache.js';
if (!process.env.JWT_SECRET || !process.env.ADMIN_JWT_SECRET) {
    throw new Error('JWT_SECRET and ADMIN_JWT_SECRET environment variables must be set');
}
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;
export const generateToken = (payload) => {
    return jwt.sign(payload, JWT_SECRET);
};
export const generateAdminToken = (payload) => {
    return jwt.sign(payload, ADMIN_JWT_SECRET, { expiresIn: '12h' });
};
/**
 * Loads the caller's role, business and branch assignments — from Redis when it's warm,
 * otherwise from Mongo, priming the cache on the way through. See utils/authCache.ts for why
 * this is safe to cache and what evicts it.
 *
 * The two Mongo reads are issued together rather than sequentially: the branch lookup keys
 * off the user id, which we already have from the verified token, so it never needed to wait
 * on the user document.
 */
async function loadUserContext(userId) {
    const cached = await getCachedUserContext(userId);
    if (cached)
        return cached;
    const [user, assignments] = await Promise.all([
        // Only the fields this middleware actually decides on — the full document carried
        // password_hash and pin_encrypted into memory on every single request.
        User.findOne({ _id: userId, deleted_at: null })
            .select('role business_id session_epoch is_active')
            .lean(),
        UserBranch.find({ user_id: userId }).select('branch_id').lean(),
    ]);
    if (!user)
        return null;
    const ctx = {
        role: user.role,
        businessId: user.business_id ? String(user.business_id) : null,
        sessionEpoch: user.session_epoch ?? 0,
        // Strict equality, not `!== false`. This check replaced an `is_active: true` clause in
        // the query itself, and a missing field does not match that clause — but .lean() skips
        // Mongoose's schema defaults, so a document with no is_active field at all reads back as
        // undefined rather than defaulting to true. Treating undefined as active would let
        // pre-revamp user records (which carry `isActive`, not `is_active`) through a gate that
        // previously rejected them.
        isActive: user.is_active === true,
        branchIds: user.role === 'owner' ? null : assignments.map((a) => String(a.branch_id)),
    };
    await setCachedUserContext(userId, ctx);
    return ctx;
}
async function loadBusinessStatus(businessId) {
    const cached = await getCachedBusinessContext(businessId);
    if (cached)
        return cached.status;
    const business = await Business.findById(businessId).select('status').lean();
    if (!business)
        return null;
    await setCachedBusinessContext(businessId, { status: business.status });
    return business.status;
}
export const sessionVerification = async (req, res, next) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ message: 'Session expired or invalid' });
    }
    const token = req.session.token;
    if (!token) {
        return res.status(401).json({ message: 'Authentication required' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.id !== String(req.session.userId)) {
            return res.status(401).json({ message: 'Session mismatch' });
        }
        const ctx = await loadUserContext(decoded.id);
        if (!ctx || !ctx.isActive) {
            return res.status(401).json({ message: 'Access denied' });
        }
        // Any change that must take effect immediately (role change, PIN change, disable) bumps
        // the user's session_epoch — see invalidateUserSessions(). A session minted before that
        // bump is stale and dies here rather than living on until its 7-day cookie expires.
        // Both sides default to 0 so sessions already in flight when this shipped stay valid —
        // they predate the field and would otherwise all be logged out at deploy. To force a
        // global re-login deliberately, bump every user's session_epoch by one.
        //
        // invalidateUserSessions() evicts the cached context in the same breath as bumping the
        // epoch, so a cache hit can never serve a pre-bump epoch and mask a revocation.
        const sessionEpoch = req.session.epoch ?? 0;
        if (sessionEpoch !== ctx.sessionEpoch) {
            return res.status(401).json({
                code: 'PERMISSIONS_CHANGED',
                message: 'Your access has been updated. Please log in again.',
            });
        }
        if (ctx.businessId) {
            const status = await loadBusinessStatus(ctx.businessId);
            if (status && status !== 'active') {
                return res.status(403).json({ message: 'This account has been paused. Please contact Apsara support.' });
            }
        }
        // Role and business come from the record we just loaded, NOT from the token. The token is
        // signed once at login and never changes, so reading `decoded.role` here left a demoted
        // user holding their old powers until the session expired — up to 7 days. Every
        // authorizeRoles() check downstream depends on this being the live value.
        req.user = {
            id: decoded.id,
            role: ctx.role,
            businessId: ctx.businessId ?? undefined,
            branchIds: ctx.branchIds,
        };
        next();
    }
    catch {
        return res.status(401).json({ message: 'Invalid session token' });
    }
};
// Returns null for owners (unrestricted — all branches in the business), or the list of
// branch IDs (as strings) a manager/worker is assigned to via UserBranch. Use this to
// clip or reject any `branch_id` query param instead of trusting it directly — without
// it, a manager/worker can pass another branch's ID and read its data.
//
// Resolved by sessionVerification and carried on req.user, so the repeat calls within a
// single request (the orders list route alone asks twice) are free. The query remains as a
// fallback for the few callers that construct a user object themselves.
export const getAccessibleBranchIds = async (user) => {
    if (user.branchIds !== undefined)
        return user.branchIds;
    if (user.role === 'owner')
        return null;
    const assignments = await UserBranch.find({ user_id: user.id }).select('branch_id').lean();
    return assignments.map((a) => String(a.branch_id));
};
export const authorizeRoles = (...roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ message: 'Unauthorized' });
        }
        next();
    };
};
export const adminAuthMiddleware = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token)
        return res.status(401).json({ message: 'Authentication required' });
    try {
        const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
        req.user = decoded;
        next();
    }
    catch {
        return res.status(403).json({ message: 'Invalid admin token' });
    }
};
