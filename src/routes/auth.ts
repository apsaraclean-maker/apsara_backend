import { Router } from 'express';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import crypto from 'crypto';
import { DateTime } from 'luxon';
import { User, Business, OTP } from '../models.js';
import { generateToken, sessionVerification, type AuthRequest } from '../middleware/auth.js';

const router = Router();

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 120;

async function verifyRecaptcha(token: string): Promise<boolean> {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) return true; // skip in dev if not configured
  try {
    const response = await axios.post('https://www.google.com/recaptcha/api/siteverify', null, {
      params: { secret, response: token },
    });
    return response.data.success === true;
  } catch {
    return false;
  }
}

// POST /api/auth/register-business
router.post('/register-business', async (req, res) => {
  const { businessName, ownerName, phone, address, pincode, state, password, recaptchaToken } = req.body;
  try {
    if (recaptchaToken) {
      const valid = await verifyRecaptcha(recaptchaToken);
      if (!valid) return res.status(400).json({ message: 'reCAPTCHA verification failed' });
    }

    const existing = await User.findOne({ phone });
    if (existing) return res.status(400).json({ message: 'Phone already registered' });

    const password_hash = await bcrypt.hash(password, 10);

    const owner = await User.create({
      name: ownerName,
      phone,
      password_hash,
      role: 'owner',
      is_active: true,
    });

    const business = await Business.create({
      name: businessName,
      owner_id: owner._id,
      phone,
      address: address || '',
      pincode: pincode || '',
      state: state || '',
      status: 'active',
    });

    owner.business_id = business._id as any;
    await owner.save();

    const token = generateToken({ id: owner._id, role: 'owner', businessId: business._id });
    (req.session as any).userId = String(owner._id);
    (req.session as any).token = token;

    res.status(201).json({ message: 'Business registered successfully', token });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { phone, password, recaptchaToken } = req.body;
  try {
    if (recaptchaToken) {
      const valid = await verifyRecaptcha(recaptchaToken);
      if (!valid) return res.status(400).json({ message: 'reCAPTCHA verification failed' });
    }

    const user = await User.findOne({ phone, deleted_at: null });
    if (!user) return res.status(404).json({ message: 'Account not found' });

    // Check lockout
    if (user.locked_until) {
      const lockedUntil = DateTime.fromISO(user.locked_until);
      if (DateTime.now().toUTC() < lockedUntil) {
        const minutesLeft = Math.ceil(lockedUntil.diffNow('minutes').minutes);
        return res.status(403).json({
          message: `Account locked. Try again in ${minutesLeft} minute(s).`,
          locked_until: user.locked_until,
        });
      } else {
        user.locked_until = null;
        user.failed_login_count = 0;
      }
    }

    if (!user.is_active) {
      return res.status(403).json({ message: 'Account is inactive' });
    }

    if (user.business_id) {
      const business = await Business.findById(user.business_id);
      if (business && business.status !== 'active') {
        return res.status(403).json({ message: 'This account has been paused. Please contact Apsara support.' });
      }
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      user.failed_login_count = (user.failed_login_count || 0) + 1;
      if (user.failed_login_count >= MAX_FAILED_ATTEMPTS) {
        user.locked_until = DateTime.now().toUTC().plus({ minutes: LOCKOUT_MINUTES }).toISO();
        await user.save();
        return res.status(403).json({
          message: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`,
        });
      }
      await user.save();
      return res.status(400).json({
        message: 'Invalid credentials',
        attempts_remaining: MAX_FAILED_ATTEMPTS - user.failed_login_count,
      });
    }

    // Reset on success
    user.failed_login_count = 0;
    user.locked_until = null;
    await user.save();

    const token = generateToken({ id: user._id, role: user.role as any, businessId: user.business_id });
    (req.session as any).userId = String(user._id);
    (req.session as any).token = token;

    res.json({
      message: 'Login successful',
      user: { id: user._id, name: user.name, role: user.role, businessId: user.business_id },
      token,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ message: 'Logout failed' });
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out successfully' });
  });
});

// GET /api/auth/me
router.get('/me', sessionVerification, async (req: AuthRequest, res) => {
  try {
    const user = await User.findOne({ _id: req.user!.id, is_active: true, deleted_at: null }).select(
      '-password_hash -pin_hash'
    );
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/request-otp (for staff verification flows)
router.post('/request-otp', sessionVerification, async (req, res) => {
  const { phone } = req.body;
  try {
    const code = String(parseInt(crypto.randomBytes(3).toString('hex'), 16) % 900000 + 100000);
    await OTP.create({ phone, otp: code });
    res.json({ message: 'OTP sent', phone });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  try {
    const otpDoc = await OTP.findOne({ phone, otp });
    if (!otpDoc) return res.status(400).json({ message: 'Invalid or expired OTP' });
    await OTP.deleteOne({ phone });
    res.json({ message: 'OTP verified' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
