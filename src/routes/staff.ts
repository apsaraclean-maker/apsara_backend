import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { User, UserBranch, ArchivedUser } from '../models.js';
import { sessionVerification, authorizeRoles, type AuthRequest } from '../middleware/auth.js';
import { encryptPin, decryptPin } from '../utils/pinCrypto.js';
import { buildSearchRegex } from '../utils/searchRegex.js';
import { invalidateUserSessions } from '../utils/sessionControl.js';
import { invalidateUserContext } from '../utils/authCache.js';

const router = Router();
router.use(sessionVerification);

const PIN_REGEX = /^\d{4,6}$/;
const PHONE_REGEX = /^[6-9]\d{9}$/;

// Staff (manager/worker) log in via PIN, not a password — the Add Staff Drawer has no
// password field per the PRD. The schema still requires a password_hash, so we fill it
// with a random, never-surfaced value that's simply unusable for login.
function randomUnusedPasswordHash() {
  return bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
}

// Also used by /auth/register-business to assign the owner their Emp. ID, so owners and
// managers share one namespace — see takenEmployeeIds() below.
export function generateEmployeeId(name: string, existingIds: string[]): string {
  const initials = name
    .split(' ')
    .map((w) => w[0]?.toUpperCase() || '')
    .join('')
    .slice(0, 2);

  let counter = 0;
  let candidateId = `${initials}${counter}`;
  while (existingIds.includes(candidateId)) {
    counter++;
    candidateId = `${initials}${counter}`;
  }
  return candidateId;
}

// Every Emp. ID in a business lives in one namespace enforced by the unique
// (business_id, employee_id) index, and the owner holds one too — so the taken-ID list has
// to span owners and managers alike. Querying managers only would let a new manager compute
// an ID the owner already has and fail on the duplicate key.
export async function takenEmployeeIds(businessId: unknown, excludeUserId?: unknown): Promise<string[]> {
  const query: any = {
    business_id: businessId,
    role: { $in: ['owner', 'manager'] },
    deleted_at: null,
    employee_id: { $ne: null },
  };
  if (excludeUserId) query._id = { $ne: excludeUserId };
  const users = await User.find(query).select('employee_id').lean();
  return users.map((u) => u.employee_id as string);
}

// GET /api/staff — viewable by all roles (owner/manager/worker); PIN is only ever
// attached in the response for the owner (see enrichment below).
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { branch_id, role, search, is_active } = req.query;

    // The Staff Page lists managers and workers. `role` narrows that, and also accepts a
    // comma-separated list — the Orders filter's "Created By" asks for `owner,manager`,
    // since those are the only roles that can create an order (PRD persona rules), and the
    // owner would otherwise be missing from a list of people who created orders.
    const requestedRoles = role ? String(role).split(',').map((r) => r.trim()).filter(Boolean) : null;
    const allowedRoles = requestedRoles ?? ['manager', 'worker'];
    const query: any = {
      business_id: req.user!.businessId,
      deleted_at: null,
      role: { $in: allowedRoles.filter((r) => ['owner', 'manager', 'worker'].includes(r)) },
    };
    // Staff Page filter panel's tri-state status (all / active / inactive).
    if (is_active === 'true' || is_active === 'false') query.is_active = is_active === 'true';
    const re = buildSearchRegex(search);
    if (re) {
      query.$or = [{ name: re }, { phone: re }];
    }

    // Branch filtering happens in the query rather than after it. This used to load every
    // staff member in the business and then drop the non-matching ones in JavaScript, which
    // meant fetching (and decrypting PINs for) people the caller had explicitly filtered out.
    if (branch_id) {
      const links = await UserBranch.find({ branch_id: new mongoose.Types.ObjectId(branch_id as string) })
        .select('user_id')
        .lean();
      query._id = { $in: links.map((l) => l.user_id) };
    }

    const staff = await User.find(query).select('-password_hash').sort({ name: 1 }).lean();

    // Only the owner can see PINs (per PRD's persona rules) — decrypt for display here
    // rather than leaking the encrypted blob to managers/workers.
    const isOwner = req.user!.role === 'owner';

    // Branch assignments for the whole list in one query, grouped by user. This was a
    // populate() call per staff member inside staff.map(async …) — a business with 40 staff
    // issued 40 round trips to render one page.
    const allLinks = await UserBranch.find({ user_id: { $in: staff.map((u) => u._id) } })
      .populate('branch_id', 'name branch_code')
      .lean();
    const branchesByUser = new Map<string, any[]>();
    for (const link of allLinks) {
      const key = String(link.user_id);
      if (!branchesByUser.has(key)) branchesByUser.set(key, []);
      branchesByUser.get(key)!.push(link.branch_id);
    }

    const enriched = staff.map((u) => {
      const obj: any = { ...u, branches: branchesByUser.get(String(u._id)) ?? [] };
      obj.pin = isOwner && obj.pin_encrypted ? decryptPin(obj.pin_encrypted) : null;
      delete obj.pin_encrypted;
      return obj;
    });

    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/staff/counts
router.get('/counts', async (req: AuthRequest, res) => {
  try {
    const [active, total] = await Promise.all([
      User.countDocuments({ business_id: req.user!.businessId, role: { $in: ['manager', 'worker'] }, is_active: true, deleted_at: null }),
      User.countDocuments({ business_id: req.user!.businessId, role: { $in: ['manager', 'worker'] }, deleted_at: null }),
    ]);
    res.json({ active, total });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/staff
router.post('/', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  const { name, phone, pin, role, branch_ids } = req.body;
  try {
    if (!name?.trim()) return res.status(400).json({ message: 'Staff name is required' });
    if (name.length > 100) return res.status(400).json({ message: 'Staff name cannot exceed 100 characters' });
    if (!PHONE_REGEX.test(phone || '')) return res.status(400).json({ message: 'Enter a valid 10-digit phone number' });
    if (!PIN_REGEX.test(String(pin ?? ''))) return res.status(400).json({ message: 'PIN must be 4-6 digits' });
    if (!branch_ids?.length) return res.status(400).json({ message: 'Select at least one branch' });
    if (role && role !== 'manager' && role !== 'worker') return res.status(400).json({ message: 'Invalid staff type' });

    const existing = await User.findOne({ phone, deleted_at: null }).select('_id').lean();
    if (existing) return res.status(400).json({ message: 'Phone number already in use' });

    const password_hash = await randomUnusedPasswordHash();
    const pin_encrypted = encryptPin(String(pin));

    let employee_id = null;
    if (role === 'manager') {
      employee_id = generateEmployeeId(name, await takenEmployeeIds(req.user!.businessId));
    }

    const staff = await User.create({
      business_id: req.user!.businessId,
      name,
      phone,
      password_hash,
      pin_encrypted,
      role: role || 'worker',
      employee_id,
      is_active: true,
    });

    await UserBranch.insertMany(
      branch_ids.map((bid: string) => ({ user_id: staff._id, branch_id: bid }))
    );

    res.status(201).json({ ...staff.toObject(), password_hash: undefined, pin_encrypted: undefined, pin: String(pin) });
  } catch (err: any) {
    // Guards the narrow race window in generateEmployeeId() above — two concurrent creates
    // could compute the same employee_id before either write lands; the unique index on
    // models.ts's User schema catches it here instead of silently allowing duplicates.
    if (err.code === 11000 && err.keyPattern?.employee_id) {
      return res.status(409).json({ message: 'Employee ID collision — please try creating this staff member again.' });
    }
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/staff/:id
router.put('/:id', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  const { name, phone, pin, role, is_active, branch_ids } = req.body;
  try {
    if (name !== undefined && !name.trim()) return res.status(400).json({ message: 'Staff name is required' });
    if (name !== undefined && name.length > 100) return res.status(400).json({ message: 'Staff name cannot exceed 100 characters' });
    if (phone !== undefined && !PHONE_REGEX.test(phone)) return res.status(400).json({ message: 'Enter a valid 10-digit phone number' });
    if (pin && !PIN_REGEX.test(String(pin))) return res.status(400).json({ message: 'PIN must be 4-6 digits' });
    if (branch_ids !== undefined && !branch_ids.length && is_active !== false) {
      return res.status(400).json({ message: 'Select at least one branch' });
    }
    if (role && role !== 'manager' && role !== 'worker') return res.status(400).json({ message: 'Invalid staff type' });

    const staff = await User.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!staff) return res.status(404).json({ message: 'Staff not found' });

    if (is_active === true) {
      const branchCount = branch_ids !== undefined ? branch_ids.length : await UserBranch.countDocuments({ user_id: staff._id });
      if (!branchCount) {
        return res.status(400).json({ message: 'Please link the staff to at least one branch to enable.' });
      }
    }

    if (name) staff.name = name;
    if (phone && phone !== staff.phone) {
      const conflict = await User.findOne({ phone, deleted_at: null, _id: { $ne: staff._id } }).select('_id').lean();
      if (conflict) return res.status(400).json({ message: 'Phone number already in use' });
      staff.phone = phone;
    }
    if (pin) staff.pin_encrypted = encryptPin(String(pin));

    // Re-enabling has to clear the lockout state too. The escalation in auth.ts leaves a
    // disabled account with failed_login_count at 30 and, without this, the owner flips the
    // toggle back on only for the member's next mistyped PIN to disable them again instantly.
    if (is_active !== undefined) {
      if (is_active === true && !staff.is_active) {
        staff.failed_login_count = 0;
        staff.locked_until = null;
      }
      staff.is_active = is_active;
    }

    // Anything that changes what this person can do, or how they authenticate, must end
    // their existing sessions rather than wait up to 7 days for the cookie to expire.
    const mustReauthenticate = (!!role && role !== staff.role) || !!pin || is_active === false;

    // Handle role change + employee ID
    if (role && role !== staff.role) {
      staff.role = role;
      if (role === 'manager' && !staff.employee_id) {
        staff.employee_id = generateEmployeeId(
          staff.name,
          await takenEmployeeIds(req.user!.businessId, staff._id)
        );
      } else if (role === 'worker') {
        staff.employee_id = null;
      }
    }

    staff.updatedAt = DateTime.now().toUTC().toJSDate();
    await staff.save();

    if (branch_ids !== undefined) {
      await UserBranch.deleteMany({ user_id: staff._id });
      if (branch_ids.length) {
        await UserBranch.insertMany(branch_ids.map((bid: string) => ({ user_id: staff._id, branch_id: bid })));
      }
    }

    // After the save, so a failed write can't sign someone out for a change that never landed.
    if (mustReauthenticate) {
      await invalidateUserSessions(staff._id, req.sessionStore);
    } else {
      // Not every edit ends the session — reassigning branches doesn't — but it still changes
      // what this person can see, and sessionVerification reads that from a cache. Evict it
      // so the new assignment applies on their very next request rather than up to a minute
      // later. invalidateUserSessions already does this on the paths that go through it.
      await invalidateUserContext(staff._id);
    }

    res.json({
      ...staff.toObject(),
      password_hash: undefined,
      pin_encrypted: undefined,
      pin: staff.pin_encrypted ? decryptPin(staff.pin_encrypted) : null,
    });
  } catch (err: any) {
    if (err.code === 11000 && err.keyPattern?.employee_id) {
      return res.status(409).json({ message: 'Employee ID collision — please try again.' });
    }
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/staff/:id (soft delete + archive)
router.delete('/:id', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  try {
    const staff = await User.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!staff) return res.status(404).json({ message: 'Staff not found' });

    await ArchivedUser.create({
      original_id: staff._id,
      name: staff.name,
      phone: staff.phone,
      role: staff.role,
      business_id: staff.business_id,
      old_details: staff.toObject(),
      archived_by: req.user!.id,
    });

    staff.deleted_at = DateTime.now().toUTC().toJSDate();
    staff.is_active = false;
    await staff.save();

    await UserBranch.deleteMany({ user_id: staff._id });
    // sessionVerification already rejects a soft-deleted user on their next request, so this
    // is mainly to clear their ActiveSession rows rather than leave them counting against the
    // device limit until the 7-day TTL.
    await invalidateUserSessions(staff._id, req.sessionStore);

    res.json({ message: 'Staff removed successfully' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
