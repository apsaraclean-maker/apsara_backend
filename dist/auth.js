import 'dotenv/config';
import jwt from 'jsonwebtoken';
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
export const generateToken = (payload) => {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
};
export const authenticateToken = (req, res, next) => {
    const token = req.session.token || req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ message: 'Authentication required' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    }
    catch (error) {
        return res.status(403).json({ message: 'Invalid or expired token' });
    }
};
export const authorizeRoles = (...roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ message: 'Unauthorized access' });
        }
        next();
    };
};
export const sessionVerification = (req, res, next) => {
    // Check if session exists in MongoDB (managed by express-session)
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ message: 'Session expired or invalid' });
    }
    // Double check with JWT inside session or cookie
    const token = req.session.token;
    if (!token) {
        return res.status(401).json({ message: 'JWT token missing' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.id !== req.session.userId) {
            return res.status(401).json({ message: 'Session and Token mismatch' });
        }
        req.user = decoded;
        next();
    }
    catch (err) {
        return res.status(401).json({ message: 'Invalid token in session' });
    }
};
