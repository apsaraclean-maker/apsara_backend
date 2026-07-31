import { Router } from 'express';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import crypto from 'crypto';
import { DateTime } from 'luxon';
import { User, Business, Branch, ActiveSession, OTP } from '../models.js';
import { generateToken, sessionVerification } from '../middleware/auth.js';
import { decryptPin, encryptPin, generatePin } from '../utils/pinCrypto.js';
import { generateBranchCode } from './branches.js';
import { generateEmployeeId } from './staff.js';
import { deriveDeviceLabel } from '../utils/deviceLabel.js';
const router = Router();
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 120;
const MAX_CONCURRENT_SESSIONS = 3;
// Owners/admins authenticate with their password; managers/workers with their PIN (PIN
// replaces password for staff login). PINs are reversibly encrypted, not hashed, so the
// owner can view them on the Staff Page — the check here is decrypt-and-compare instead of
// bcrypt.compare. Shared between /login and /revoke-session (which re-authenticates the
// same way to free up a device slot).
async function verifyCredential(user, password) {
    if (user.role === 'owner' || user.role === 'admin') {
        return bcrypt.compare(password, user.password_hash);
    }
    return !!user.pin_encrypted && decryptPin(user.pin_encrypted) === password;
}
async function verifyRecaptcha(token) {
    const secret = process.env.RECAPTCHA_SECRET_KEY;
    if (!secret)
        return true; // skip in dev if not configured
    try {
        const response = await axios.post('https://www.google.com/recaptcha/api/siteverify', null, {
            params: { secret, response: token },
        });
        return response.data.success === true;
    }
    catch {
        return false;
    }
}
// POST /api/auth/register-business
router.post('/register-business', async (req, res) => {
    const { businessName, ownerName, phone, address, pincode, state, password, recaptchaToken } = req.body;
    try {
        if (recaptchaToken) {
            const valid = await verifyRecaptcha(recaptchaToken);
            if (!valid)
                return res.status(400).json({ message: 'reCAPTCHA verification failed' });
        }
        const existing = await User.findOne({ phone, deleted_at: null });
        if (existing)
            return res.status(400).json({ message: 'Phone already registered' });
        const password_hash = await bcrypt.hash(password, 10);
        const owner = await User.create({
            name: ownerName,
            phone,
            password_hash,
            role: 'owner',
            // The Business Page shows every persona their own Emp. ID and PIN, so the owner is
            // assigned one too. It is generated rather than chosen because there is nobody to
            // set it for them. This is display-only: verifyCredential() above authenticates
            // owners by password, so an owner PIN opens no login path.
            pin_encrypted: encryptPin(generatePin()),
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
        owner.business_id = business._id;
        // Derived from the owner's name, exactly like a manager's (Anshul Prajapati -> AP0).
        // Assigned only now that business_id is set: the unique (business_id, employee_id)
        // index scopes IDs per business, so computing one while business_id was still null
        // put every owner on the platform on the same (null, ...) key — the second business
        // to register would have failed on a duplicate key. The business is new, so nothing
        // else holds an ID yet.
        owner.employee_id = generateEmployeeId(ownerName, []);
        await owner.save();
        // A business must always have at least one branch (nothing else in the app — orders,
        // services, staff assignments — works without one), so registration creates a default
        // one atomically rather than leaving a brand-new business in an unusable zero-branch
        // state until the owner separately visits Create Branch. Only what registration
        // actually collects is available (no map/lat-lng at this step), so location fields are
        // left blank for the owner to fill in later via Edit Branch.
        await Branch.create({
            business_id: business._id,
            name: 'Main Branch',
            branch_code: generateBranchCode(businessName, []),
            address_line_1: address || '',
            pincode: pincode || '',
            state: state || '',
        });
        const token = generateToken({ id: owner._id, role: 'owner', businessId: business._id });
        req.session.userId = String(owner._id);
        req.session.token = token;
        res.status(201).json({ message: 'Business registered successfully', token });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { phone, password, recaptchaToken } = req.body;
    try {
        if (recaptchaToken) {
            const valid = await verifyRecaptcha(recaptchaToken);
            if (!valid)
                return res.status(400).json({ message: 'reCAPTCHA verification failed' });
        }
        const user = await User.findOne({ phone, deleted_at: null });
        if (!user)
            return res.status(404).json({ message: 'Account not found' });
        // Check lockout
        if (user.locked_until) {
            const lockedUntil = DateTime.fromISO(user.locked_until);
            if (DateTime.now().toUTC() < lockedUntil) {
                const minutesLeft = Math.ceil(lockedUntil.diffNow('minutes').minutes);
                return res.status(403).json({
                    message: `Account locked. Try again in ${minutesLeft} minute(s).`,
                    locked_until: user.locked_until,
                });
            }
            else {
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
        const isMatch = await verifyCredential(user, password);
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
        // Concurrent-session limit: reject the 4th simultaneous login instead of silently
        // allowing unlimited devices. Sessions past their TTL age out of ActiveSession
        // automatically (matches the session cookie's own 7-day maxAge), so this only ever
        // counts genuinely-active devices, not abandoned ones.
        const activeSessions = await ActiveSession.find({ user_id: user._id }).sort({ createdAt: 1 });
        if (activeSessions.length >= MAX_CONCURRENT_SESSIONS) {
            return res.status(403).json({
                message: `Device limit reached (max ${MAX_CONCURRENT_SESSIONS}). Log out from another device to continue.`,
                active_sessions: activeSessions.map((s) => ({ id: s._id, device_label: s.device_label, created_at: s.createdAt })),
            });
        }
        const token = generateToken({ id: user._id, role: user.role, businessId: user.business_id });
        req.session.userId = String(user._id);
        req.session.token = token;
        await ActiveSession.create({
            user_id: user._id,
            session_id: req.sessionID,
            device_label: deriveDeviceLabel(req.headers['user-agent']),
            ip_address: req.ip || '',
        });
        res.json({
            message: 'Login successful',
            user: { id: user._id, name: user.name, role: user.role, businessId: user.business_id },
            token,
        });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// POST /api/auth/revoke-session — frees up a device slot when the concurrent-session limit
// is hit. Re-authenticates with the same credential the caller would use to log in (rather
// than requiring an existing session, which is exactly what they don't have at this point),
// then destroys that specific session both in ActiveSession and the actual session store.
router.post('/revoke-session', async (req, res) => {
    // active_session_id is the ActiveSession document's own _id (the "id" field returned in
    // /login's active_sessions list) — deliberately not the raw express-session id, which
    // clients never see.
    const { phone, password, active_session_id } = req.body;
    if (!active_session_id)
        return res.status(400).json({ message: 'active_session_id is required' });
    try {
        const user = await User.findOne({ phone, deleted_at: null });
        if (!user)
            return res.status(404).json({ message: 'Account not found' });
        const isMatch = await verifyCredential(user, password);
        if (!isMatch)
            return res.status(400).json({ message: 'Invalid credentials' });
        const session = await ActiveSession.findOne({ _id: active_session_id, user_id: user._id });
        if (!session)
            return res.status(404).json({ message: 'Session not found' });
        // Freeing the counted slot (ActiveSession) matters more than a clean session-store
        // destroy succeeding — a transient store hiccup shouldn't leave the caller unable to
        // log in at all. The old session still naturally expires via its own TTL either way.
        await new Promise((resolve) => {
            req.sessionStore.destroy(session.session_id, (err) => {
                if (err)
                    console.error('[revoke-session] session store destroy failed (non-fatal):', err.message);
                resolve();
            });
        });
        await ActiveSession.deleteOne({ _id: session._id });
        res.json({ message: 'Session revoked — you can now log in.' });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// POST /api/auth/logout
router.post('/logout', async (req, res) => {
    await ActiveSession.deleteOne({ session_id: req.sessionID });
    req.session.destroy((err) => {
        if (err)
            return res.status(500).json({ message: 'Logout failed' });
        res.clearCookie('connect.sid');
        res.json({ message: 'Logged out successfully' });
    });
});
// GET /api/auth/me
router.get('/me', sessionVerification, async (req, res) => {
    try {
        const user = await User.findOne({ _id: req.user.id, is_active: true, deleted_at: null }).select('-password_hash -pin_encrypted');
        if (!user)
            return res.status(404).json({ message: 'User not found' });
        // The platform header shows the business name next to the Apsara mark on every page,
        // so it rides along here rather than costing a separate request per page load.
        // Appended as a scalar instead of populating business_id, which callers use as an id.
        const business = user.business_id ? await Business.findById(user.business_id).select('name') : null;
        res.json({ ...user.toObject(), business_name: business?.name || '' });
    }
    catch (err) {
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
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;
    try {
        const otpDoc = await OTP.findOne({ phone, otp });
        if (!otpDoc)
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        await OTP.deleteOne({ phone });
        res.json({ message: 'OTP verified' });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
export default router;
