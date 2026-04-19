import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { User } from './models.js';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

export const generateToken = (payload: any) => {
  return jwt.sign(payload, JWT_SECRET);
};

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: number;
    businessId?: string;
  };
}

export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = (req.session as any ).token || req.headers.authorization?.split(' ')[1];
console.log(token,"--ytjis");

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

export const authorizeRoles = (...roles: number[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Unauthorized access' });
    }
    next();
  };
};

export const sessionVerification = async(req: AuthRequest, res: Response, next: NextFunction) => {
  // Check if session exists in MongoDB (managed by express-session)
  
  if (!req.session || !(req.session as any).userId) {
    return res.status(401).json({ message: 'Session expired or invalid' });
  }
  
  // Double check with JWT inside session or cookie
  const token = (req.session as any).token;
  if (!token) {
    return res.status(401).json({ message: 'JWT token missing' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.id !== (req.session as any).userId) {
      return res.status(401).json({ message: 'Session and Token mismatch' });
    }
    
    
    const user = await User.findOne({_id:decoded.id,statusId:1})

    if(!user)
    {
      return res.status(401).json({ message: 'Access Denied' });
      
    }
    





    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token in session' });
  }
};
