import { Router } from 'express';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import { User, Business, Branch, ActiveSession } from '../models.js';
import { generateToken, sessionVerification, type AuthRequest } from '../middleware/auth.js';
import { decryptPin, encryptPin, generatePin } from '../utils/pinCrypto.js';
import { generateBranchCode } from './branches.js';
import { generateEmployeeId } from './staff.js';
import { deriveDeviceLabel } from '../utils/deviceLabel.js';
import { invalidateUserSessions } from '../utils/sessionControl.js';

const router = Router();

const MAX_FAILED_ATTEMPTS = 10;   // wrong guesses per lockout cycle
const LOCKOUT_MINUTES = 120;      // cooldown served at 10 and at 20
const DISABLE_AFTER_ATTEMPTS = 30; // third cycle disables the account outright
const MAX_CONCURRENT_SESSIONS = 3;

// Owners/admins authenticate with their password; managers/workers with their PIN (PIN
// replaces password for staff login). PINs are reversibly encrypted, not hashed, so the
// owner can view them on the Staff Page — the check here is decrypt-and-compare instead of
// bcrypt.compare. Shared between /login and /revoke-session (which re-authenticates the
// same way to free up a device slot).
async function verifyCredential(user: InstanceType<typeof User>, password: string): Promise<boolean> {
  if (user.role === 'owner' || user.role === 'admin') {
    return bcrypt.compare(password, user.password_hash);
  }
  return !!user.pin_encrypted && decryptPin(user.pin_encrypted) === password;
}

// ─── Shared credential check ──────────────────────────────────────────────────
// Both /login and /revoke-session authenticate the same way, so they must also throttle the
// same way. They previously didn't: /revoke-session ran verifyCredential directly with no
// lockout check, no attempt counting and no CAPTCHA, which made every protection on /login
// bypassable by simply knocking on the other door. Since staff authenticate with a 5-digit
// PIN (~90k possibilities), an unthrottled endpoint is enough to walk the whole keyspace.
// Everything below therefore lives in one function that both routes are required to go
// through, rather than being duplicated per-route where it can drift out of sync again.

type LoginFailure = { status: number; body: Record<string, unknown> };
type LoginOutcome =
  | { ok: true; user: InstanceType<typeof User> }
  | { ok: false; failure: LoginFailure };

// One message for "no such account" and "wrong credential" alike. Returning 404 for an
// unknown phone number let anyone test which numbers have accounts just by watching the
// status code.
const INVALID_CREDENTIALS: LoginFailure = {
  status: 400,
  body: { code: 'INVALID_CREDENTIALS', message: 'Account or Password may be incorrect.' },
};

// The lockout and disabled responses below do still confirm that an account exists — that's
// a deliberate trade. This userbase is not tech-savvy, and a locked-out worker who is told
// only "Account or Password may be incorrect" has no way to understand why the right PIN
// stopped working or what to do next. Making these generic too would need decoy counters for
// phone numbers that don't exist, and would cost exactly the guidance they're here to give.
function accountDisabled(role: string): LoginFailure {
  const isOwner = role === 'owner' || role === 'admin';
  return {
    status: 403,
    body: {
      code: isOwner ? 'ACCOUNT_DISABLED_OWNER' : 'ACCOUNT_DISABLED_STAFF',
      message: isOwner
        ? 'Your account has been disabled after too many failed login attempts. Please contact Apsara support to reactivate it.'
        : 'Your account has been disabled after too many failed login attempts. Please ask your business owner to reactivate it from the Staff page.',
    },
  };
}

/**
 * Resolves a phone + credential pair, applying the full lockout/disable escalation:
 * 10 wrong guesses → 2h cooldown, 20 → another 2h, 30 → account disabled.
 *
 * `failed_login_count` is cumulative and is deliberately not cleared when a cooldown
 * expires — clearing it there (as this used to) meant the count reset to zero every two
 * hours and could never reach the disable threshold.
 */
async function verifyLogin(phone: unknown, password: unknown, store?: any): Promise<LoginOutcome> {
  // Typed guards, not just for safety: an object here would otherwise reach the Mongoose
  // filter below as a query operator. See middleware/sanitize.ts for the general defence —
  // this is the second layer on the one lookup where it matters most.
  if (typeof phone !== 'string' || typeof password !== 'string') {
    return { ok: false, failure: INVALID_CREDENTIALS };
  }

  const user = await User.findOne({ phone, deleted_at: null });
  if (!user) return { ok: false, failure: INVALID_CREDENTIALS };

  if (user.locked_until) {
    const lockedUntil = DateTime.fromISO(user.locked_until);
    if (DateTime.now().toUTC() < lockedUntil) {
      const minutesLeft = Math.ceil(lockedUntil.diffNow('minutes').minutes);
      return {
        ok: false,
        failure: {
          status: 403,
          body: {
            code: 'ACCOUNT_LOCKED',
            message: `Account locked. Try again in ${minutesLeft} minute(s).`,
            locked_until: user.locked_until,
            minutes_remaining: minutesLeft,
          },
        },
      };
    }
    // Cooldown served. Release the lock but keep the running count.
    user.locked_until = null;
  }

  if (!user.is_active) {
    return { ok: false, failure: accountDisabled(user.role) };
  }

  if (user.business_id) {
    const business = await Business.findById(user.business_id);
    if (business && business.status !== 'active') {
      return {
        ok: false,
        failure: {
          status: 403,
          body: {
            code: 'BUSINESS_PAUSED',
            message: 'This account has been paused. Please contact Apsara support.',
          },
        },
      };
    }
  }

  if (await verifyCredential(user, password)) {
    user.failed_login_count = 0;
    user.locked_until = null;
    await user.save();
    return { ok: true, user };
  }

  user.failed_login_count = (user.failed_login_count || 0) + 1;

  if (user.failed_login_count >= DISABLE_AFTER_ATTEMPTS) {
    user.is_active = false;
    user.locked_until = null; // disabled supersedes any cooldown
    await user.save();
    // They may still be signed in on another device — being disabled has to end that too.
    await invalidateUserSessions(user._id, store);
    return { ok: false, failure: accountDisabled(user.role) };
  }

  if (user.failed_login_count % MAX_FAILED_ATTEMPTS === 0) {
    user.locked_until = DateTime.now().toUTC().plus({ minutes: LOCKOUT_MINUTES }).toISO();
    await user.save();
    const cyclesLeft = (DISABLE_AFTER_ATTEMPTS - user.failed_login_count) / MAX_FAILED_ATTEMPTS;
    return {
      ok: false,
      failure: {
        status: 403,
        body: {
          code: 'ACCOUNT_LOCKED',
          message: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`
            + ` ${cyclesLeft} more lockout(s) will disable this account.`,
          locked_until: user.locked_until,
          minutes_remaining: LOCKOUT_MINUTES,
        },
      },
    };
  }

  await user.save();
  return {
    ok: false,
    failure: {
      status: INVALID_CREDENTIALS.status,
      body: {
        ...INVALID_CREDENTIALS.body,
        attempts_remaining: MAX_FAILED_ATTEMPTS - (user.failed_login_count % MAX_FAILED_ATTEMPTS),
      },
    },
  };
}

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

    const existing = await User.findOne({ phone, deleted_at: null });
    if (existing) return res.status(400).json({ message: 'Phone already registered' });

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

    owner.business_id = business._id as any;
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
    (req.session as any).userId = String(owner._id);
    (req.session as any).token = token;
    (req.session as any).epoch = owner.session_epoch;

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

    const outcome = await verifyLogin(phone, password, req.sessionStore);
    if (!outcome.ok) return res.status(outcome.failure.status).json(outcome.failure.body);
    const { user } = outcome;

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

    const token = generateToken({ id: user._id, role: user.role as any, businessId: user.business_id });
    (req.session as any).userId = String(user._id);
    (req.session as any).token = token;
    // Stamped so sessionVerification can spot a session minted before a later role/PIN change
    // and reject it — see invalidateUserSessions().
    (req.session as any).epoch = user.session_epoch;

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
  } catch (err: any) {
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
  if (typeof active_session_id !== 'string' || !mongoose.Types.ObjectId.isValid(active_session_id)) {
    // Checked up front rather than letting a malformed id reach the query, where Mongoose's
    // CastError would surface as an unhelpful 500.
    return res.status(400).json({ message: 'A valid active_session_id is required' });
  }
  try {
    // Same throttled path as /login — this endpoint used to call verifyCredential directly,
    // which meant unlimited guesses against a 5-digit staff PIN with no lockout and a clean
    // right/wrong signal in the response.
    const outcome = await verifyLogin(phone, password, req.sessionStore);
    if (!outcome.ok) return res.status(outcome.failure.status).json(outcome.failure.body);
    const { user } = outcome;

    const session = await ActiveSession.findOne({ _id: active_session_id, user_id: user._id });
    if (!session) return res.status(404).json({ message: 'Session not found' });

    // Freeing the counted slot (ActiveSession) matters more than a clean session-store
    // destroy succeeding — a transient store hiccup shouldn't leave the caller unable to
    // log in at all. The old session still naturally expires via its own TTL either way.
    await new Promise<void>((resolve) => {
      req.sessionStore.destroy(session.session_id, (err) => {
        if (err) console.error('[revoke-session] session store destroy failed (non-fatal):', err.message);
        resolve();
      });
    });
    await ActiveSession.deleteOne({ _id: session._id });

    res.json({ message: 'Session revoked — you can now log in.' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  await ActiveSession.deleteOne({ session_id: req.sessionID });
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
      '-password_hash -pin_encrypted'
    );
    if (!user) return res.status(404).json({ message: 'User not found' });
    // The platform header shows the business name next to the Apsara mark on every page,
    // so it rides along here rather than costing a separate request per page load.
    // Appended as a scalar instead of populating business_id, which callers use as an id.
    const business = user.business_id ? await Business.findById(user.business_id).select('name') : null;
    res.json({ ...user.toObject(), business_name: business?.name || '' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
