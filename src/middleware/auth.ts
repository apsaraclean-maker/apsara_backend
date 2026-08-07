import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { User, Business, UserBranch, type UserRole } from '../models.js';

if (!process.env.JWT_SECRET || !process.env.ADMIN_JWT_SECRET) {
  throw new Error('JWT_SECRET and ADMIN_JWT_SECRET environment variables must be set');
}
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: UserRole;
    businessId?: string;
  };
}

export const generateToken = (payload: { id: any; role: UserRole; businessId?: any }) => {
  return jwt.sign(payload, JWT_SECRET);
};

export const generateAdminToken = (payload: any) => {
  return jwt.sign(payload, ADMIN_JWT_SECRET, { expiresIn: '12h' });
};

export const sessionVerification = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.session || !(req.session as any).userId) {
    return res.status(401).json({ message: 'Session expired or invalid' });
  }

  const token = (req.session as any).token;
  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.id !== String((req.session as any).userId)) {
      return res.status(401).json({ message: 'Session mismatch' });
    }

    const user = await User.findOne({ _id: decoded.id, is_active: true, deleted_at: null });
    if (!user) {
      return res.status(401).json({ message: 'Access denied' });
    }

    // Any change that must take effect immediately (role change, PIN change, disable) bumps
    // the user's session_epoch — see invalidateUserSessions(). A session minted before that
    // bump is stale and dies here rather than living on until its 7-day cookie expires.
    // Both sides default to 0 so sessions already in flight when this shipped stay valid —
    // they predate the field and would otherwise all be logged out at deploy. To force a
    // global re-login deliberately, bump every user's session_epoch by one.
    const sessionEpoch = (req.session as any).epoch ?? 0;
    if (sessionEpoch !== (user.session_epoch ?? 0)) {
      return res.status(401).json({
        code: 'PERMISSIONS_CHANGED',
        message: 'Your access has been updated. Please log in again.',
      });
    }

    if (user.business_id) {
      const business = await Business.findById(user.business_id);
      if (business && business.status !== 'active') {
        return res.status(403).json({ message: 'This account has been paused. Please contact Apsara support.' });
      }
    }

    // Role and business come from the record we just loaded, NOT from the token. The token is
    // signed once at login and never changes, so reading `decoded.role` here left a demoted
    // user holding their old powers until the session expired — up to 7 days. Every
    // authorizeRoles() check downstream depends on this being the live value.
    req.user = { id: decoded.id, role: user.role as UserRole, businessId: user.business_id ? String(user.business_id) : undefined };
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid session token' });
  }
};

// Returns null for owners (unrestricted — all branches in the business), or the list of
// branch IDs (as strings) a manager/worker is assigned to via UserBranch. Use this to
// clip or reject any `branch_id` query param instead of trusting it directly — without
// it, a manager/worker can pass another branch's ID and read its data.
export const getAccessibleBranchIds = async (user: { id: string; role: UserRole }): Promise<string[] | null> => {
  if (user.role === 'owner') return null;
  const assignments = await UserBranch.find({ user_id: user.id }).select('branch_id');
  return assignments.map((a) => String(a.branch_id));
};

export const authorizeRoles = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Unauthorized' });
    }
    next();
  };
};

export const adminAuthMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET) as any;
    req.user = decoded;
    next();
  } catch {
    return res.status(403).json({ message: 'Invalid admin token' });
  }
};
