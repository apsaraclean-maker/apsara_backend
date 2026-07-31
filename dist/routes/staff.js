import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { User, UserBranch, ArchivedUser } from '../models.js';
import { sessionVerification, authorizeRoles } from '../middleware/auth.js';
import { encryptPin, decryptPin } from '../utils/pinCrypto.js';
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
export function generateEmployeeId(name, existingIds) {
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
export async function takenEmployeeIds(businessId, excludeUserId) {
    const query = {
        business_id: businessId,
        role: { $in: ['owner', 'manager'] },
        deleted_at: null,
        employee_id: { $ne: null },
    };
    if (excludeUserId)
        query._id = { $ne: excludeUserId };
    const users = await User.find(query).select('employee_id');
    return users.map((u) => u.employee_id);
}
// GET /api/staff — viewable by all roles (owner/manager/worker); PIN is only ever
// attached in the response for the owner (see enrichment below).
router.get('/', async (req, res) => {
    try {
        const { branch_id, role, search } = req.query;
        const query = { business_id: req.user.businessId, deleted_at: null, role: { $in: ['manager', 'worker'] } };
        if (role)
            query.role = role;
        if (search) {
            const re = new RegExp(String(search), 'i');
            query.$or = [{ name: re }, { phone: re }];
        }
        let staff = await User.find(query).select('-password_hash').sort({ name: 1 });
        // Filter by branch if requested
        if (branch_id) {
            const links = await UserBranch.find({ branch_id: new mongoose.Types.ObjectId(branch_id) }).select('user_id');
            const assignedIds = new Set(links.map((l) => String(l.user_id)));
            staff = staff.filter((u) => assignedIds.has(String(u._id)));
        }
        // Only the owner can see PINs (per PRD's persona rules) — decrypt for display here
        // rather than leaking the encrypted blob to managers/workers.
        const isOwner = req.user.role === 'owner';
        // Attach branch assignments
        const enriched = await Promise.all(staff.map(async (u) => {
            const branches = await UserBranch.find({ user_id: u._id }).populate('branch_id', 'name branch_code');
            const obj = { ...u.toObject(), branches: branches.map((b) => b.branch_id) };
            obj.pin = isOwner && obj.pin_encrypted ? decryptPin(obj.pin_encrypted) : null;
            delete obj.pin_encrypted;
            return obj;
        }));
        res.json(enriched);
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// GET /api/staff/counts
router.get('/counts', async (req, res) => {
    try {
        const [active, total] = await Promise.all([
            User.countDocuments({ business_id: req.user.businessId, role: { $in: ['manager', 'worker'] }, is_active: true, deleted_at: null }),
            User.countDocuments({ business_id: req.user.businessId, role: { $in: ['manager', 'worker'] }, deleted_at: null }),
        ]);
        res.json({ active, total });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// POST /api/staff
router.post('/', authorizeRoles('owner'), async (req, res) => {
    const { name, phone, pin, role, branch_ids } = req.body;
    try {
        if (!name?.trim())
            return res.status(400).json({ message: 'Staff name is required' });
        if (name.length > 100)
            return res.status(400).json({ message: 'Staff name cannot exceed 100 characters' });
        if (!PHONE_REGEX.test(phone || ''))
            return res.status(400).json({ message: 'Enter a valid 10-digit phone number' });
        if (!PIN_REGEX.test(String(pin ?? '')))
            return res.status(400).json({ message: 'PIN must be 4-6 digits' });
        if (!branch_ids?.length)
            return res.status(400).json({ message: 'Select at least one branch' });
        if (role && role !== 'manager' && role !== 'worker')
            return res.status(400).json({ message: 'Invalid staff type' });
        const existing = await User.findOne({ phone, deleted_at: null });
        if (existing)
            return res.status(400).json({ message: 'Phone number already in use' });
        const password_hash = await randomUnusedPasswordHash();
        const pin_encrypted = encryptPin(String(pin));
        let employee_id = null;
        if (role === 'manager') {
            employee_id = generateEmployeeId(name, await takenEmployeeIds(req.user.businessId));
        }
        const staff = await User.create({
            business_id: req.user.businessId,
            name,
            phone,
            password_hash,
            pin_encrypted,
            role: role || 'worker',
            employee_id,
            is_active: true,
        });
        await UserBranch.insertMany(branch_ids.map((bid) => ({ user_id: staff._id, branch_id: bid })));
        res.status(201).json({ ...staff.toObject(), password_hash: undefined, pin_encrypted: undefined, pin: String(pin) });
    }
    catch (err) {
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
router.put('/:id', authorizeRoles('owner'), async (req, res) => {
    const { name, phone, pin, role, is_active, branch_ids } = req.body;
    try {
        if (name !== undefined && !name.trim())
            return res.status(400).json({ message: 'Staff name is required' });
        if (name !== undefined && name.length > 100)
            return res.status(400).json({ message: 'Staff name cannot exceed 100 characters' });
        if (phone !== undefined && !PHONE_REGEX.test(phone))
            return res.status(400).json({ message: 'Enter a valid 10-digit phone number' });
        if (pin && !PIN_REGEX.test(String(pin)))
            return res.status(400).json({ message: 'PIN must be 4-6 digits' });
        if (branch_ids !== undefined && !branch_ids.length && is_active !== false) {
            return res.status(400).json({ message: 'Select at least one branch' });
        }
        if (role && role !== 'manager' && role !== 'worker')
            return res.status(400).json({ message: 'Invalid staff type' });
        const staff = await User.findOne({ _id: req.params.id, business_id: req.user.businessId, deleted_at: null });
        if (!staff)
            return res.status(404).json({ message: 'Staff not found' });
        if (is_active === true) {
            const branchCount = branch_ids !== undefined ? branch_ids.length : await UserBranch.countDocuments({ user_id: staff._id });
            if (!branchCount) {
                return res.status(400).json({ message: 'Please link the staff to at least one branch to enable.' });
            }
        }
        if (name)
            staff.name = name;
        if (phone && phone !== staff.phone) {
            const conflict = await User.findOne({ phone, deleted_at: null, _id: { $ne: staff._id } });
            if (conflict)
                return res.status(400).json({ message: 'Phone number already in use' });
            staff.phone = phone;
        }
        if (pin)
            staff.pin_encrypted = encryptPin(String(pin));
        if (is_active !== undefined)
            staff.is_active = is_active;
        // Handle role change + employee ID
        if (role && role !== staff.role) {
            staff.role = role;
            if (role === 'manager' && !staff.employee_id) {
                staff.employee_id = generateEmployeeId(staff.name, await takenEmployeeIds(req.user.businessId, staff._id));
            }
            else if (role === 'worker') {
                staff.employee_id = null;
            }
        }
        staff.updatedAt = DateTime.now().toUTC().toISO();
        await staff.save();
        if (branch_ids !== undefined) {
            await UserBranch.deleteMany({ user_id: staff._id });
            if (branch_ids.length) {
                await UserBranch.insertMany(branch_ids.map((bid) => ({ user_id: staff._id, branch_id: bid })));
            }
        }
        res.json({
            ...staff.toObject(),
            password_hash: undefined,
            pin_encrypted: undefined,
            pin: staff.pin_encrypted ? decryptPin(staff.pin_encrypted) : null,
        });
    }
    catch (err) {
        if (err.code === 11000 && err.keyPattern?.employee_id) {
            return res.status(409).json({ message: 'Employee ID collision — please try again.' });
        }
        res.status(500).json({ message: err.message });
    }
});
// DELETE /api/staff/:id (soft delete + archive)
router.delete('/:id', authorizeRoles('owner'), async (req, res) => {
    try {
        const staff = await User.findOne({ _id: req.params.id, business_id: req.user.businessId, deleted_at: null });
        if (!staff)
            return res.status(404).json({ message: 'Staff not found' });
        await ArchivedUser.create({
            original_id: staff._id,
            name: staff.name,
            phone: staff.phone,
            role: staff.role,
            business_id: staff.business_id,
            old_details: staff.toObject(),
            archived_by: req.user.id,
        });
        staff.deleted_at = DateTime.now().toUTC().toISO();
        staff.is_active = false;
        await staff.save();
        await UserBranch.deleteMany({ user_id: staff._id });
        res.json({ message: 'Staff removed successfully' });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
export default router;
