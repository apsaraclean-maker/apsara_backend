import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { User, UserBranch, ArchivedUser } from '../models.js';
import { sessionVerification, authorizeRoles, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(sessionVerification);

function generateEmployeeId(name: string, existingIds: string[]): string {
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

// GET /api/staff
router.get('/', authorizeRoles('owner', 'manager'), async (req: AuthRequest, res) => {
  try {
    const { branch_id, role } = req.query;

    const query: any = { business_id: req.user!.businessId, deleted_at: null, role: { $in: ['manager', 'worker'] } };
    if (role) query.role = role;

    let staff = await User.find(query).select('-password_hash -pin_hash').sort({ name: 1 });

    // Filter by branch if requested
    if (branch_id) {
      const links = await UserBranch.find({ branch_id: new mongoose.Types.ObjectId(branch_id as string) }).select('user_id');
      const assignedIds = new Set(links.map((l) => String(l.user_id)));
      staff = staff.filter((u) => assignedIds.has(String(u._id)));
    }

    // Attach branch assignments
    const enriched = await Promise.all(
      staff.map(async (u) => {
        const branches = await UserBranch.find({ user_id: u._id }).populate('branch_id', 'name branch_code');
        return { ...u.toObject(), branches: branches.map((b) => b.branch_id) };
      })
    );

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
  const { name, phone, password, pin, role, branch_ids } = req.body;
  try {
    const existing = await User.findOne({ phone });
    if (existing) return res.status(400).json({ message: 'Phone number already in use' });

    const password_hash = await bcrypt.hash(password, 10);
    const pin_hash = pin ? await bcrypt.hash(String(pin), 10) : null;

    let employee_id = null;
    if (role === 'manager') {
      const existingManagers = await User.find({
        business_id: req.user!.businessId,
        role: 'manager',
        deleted_at: null,
        employee_id: { $ne: null },
      }).select('employee_id');
      const existingIds = existingManagers.map((m) => m.employee_id as string);
      employee_id = generateEmployeeId(name, existingIds);
    }

    const staff = await User.create({
      business_id: req.user!.businessId,
      name,
      phone,
      password_hash,
      pin_hash,
      role: role || 'worker',
      employee_id,
      is_active: true,
    });

    if (branch_ids?.length) {
      await UserBranch.insertMany(
        branch_ids.map((bid: string) => ({ user_id: staff._id, branch_id: bid }))
      );
    }

    res.status(201).json({ ...staff.toObject(), password_hash: undefined, pin_hash: undefined });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/staff/:id
router.put('/:id', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  const { name, phone, password, pin, role, is_active, branch_ids } = req.body;
  try {
    const staff = await User.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!staff) return res.status(404).json({ message: 'Staff not found' });

    if (name) staff.name = name;
    if (phone && phone !== staff.phone) {
      const conflict = await User.findOne({ phone, _id: { $ne: staff._id } });
      if (conflict) return res.status(400).json({ message: 'Phone number already in use' });
      staff.phone = phone;
    }
    if (password) staff.password_hash = await bcrypt.hash(password, 10);
    if (pin !== undefined) staff.pin_hash = pin ? await bcrypt.hash(String(pin), 10) : null;
    if (is_active !== undefined) staff.is_active = is_active;

    // Handle role change + employee ID
    if (role && role !== staff.role) {
      staff.role = role;
      if (role === 'manager' && !staff.employee_id) {
        const existingManagers = await User.find({
          business_id: req.user!.businessId,
          role: 'manager',
          deleted_at: null,
          employee_id: { $ne: null },
          _id: { $ne: staff._id },
        }).select('employee_id');
        const existingIds = existingManagers.map((m) => m.employee_id as string);
        staff.employee_id = generateEmployeeId(staff.name, existingIds);
      } else if (role === 'worker') {
        staff.employee_id = null;
      }
    }

    staff.updatedAt = DateTime.now().toUTC().toISO()!;
    await staff.save();

    if (branch_ids !== undefined) {
      await UserBranch.deleteMany({ user_id: staff._id });
      if (branch_ids.length) {
        await UserBranch.insertMany(branch_ids.map((bid: string) => ({ user_id: staff._id, branch_id: bid })));
      }
    }

    res.json({ ...staff.toObject(), password_hash: undefined, pin_hash: undefined });
  } catch (err: any) {
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

    staff.deleted_at = DateTime.now().toUTC().toISO()!;
    staff.is_active = false;
    await staff.save();

    await UserBranch.deleteMany({ user_id: staff._id });

    res.json({ message: 'Staff removed successfully' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
