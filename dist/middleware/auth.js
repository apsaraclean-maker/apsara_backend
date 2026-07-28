import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { User, Business, UserBranch } from '../models.js';
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
        const user = await User.findOne({ _id: decoded.id, is_active: true, deleted_at: null });
        if (!user) {
            return res.status(401).json({ message: 'Access denied' });
        }
        if (user.business_id) {
            const business = await Business.findById(user.business_id);
            if (business && business.status !== 'active') {
                return res.status(403).json({ message: 'This account has been paused. Please contact Apsara support.' });
            }
        }
        req.user = { id: decoded.id, role: decoded.role, businessId: decoded.businessId };
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
export const getAccessibleBranchIds = async (user) => {
    if (user.role === 'owner')
        return null;
    const assignments = await UserBranch.find({ user_id: user.id }).select('branch_id');
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
