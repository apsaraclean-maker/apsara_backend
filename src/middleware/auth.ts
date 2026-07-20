import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { User, Business, type UserRole } from '../models.js';

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

    if (user.business_id) {
      const business = await Business.findById(user.business_id);
      if (business && business.status !== 'active') {
        return res.status(403).json({ message: 'This account has been paused. Please contact Apsara support.' });
      }
    }

    req.user = { id: decoded.id, role: decoded.role, businessId: decoded.businessId };
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid session token' });
  }
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
