import { Router } from 'express';
import { DateTime } from 'luxon';
import { Branch, BranchService, UserBranch, Service, User } from '../models.js';
import { sessionVerification, authorizeRoles, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(sessionVerification);

// GET /api/branches
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { businessId, role } = req.user!;
    let branches;

    if (role === 'owner') {
      branches = await Branch.find({ business_id: businessId, deleted_at: null }).sort({ createdAt: -1 });
    } else {
      // Managers and workers see only their assigned branches
      const assignments = await UserBranch.find({ user_id: req.user!.id }).select('branch_id');
      const branchIds = assignments.map((a) => a.branch_id);
      branches = await Branch.find({ _id: { $in: branchIds }, deleted_at: null }).sort({ createdAt: -1 });
    }

    // Attach service + staff counts
    const enriched = await Promise.all(
      branches.map(async (b) => {
        const [serviceCount, staffCount] = await Promise.all([
          BranchService.countDocuments({ branch_id: b._id }),
          UserBranch.countDocuments({ branch_id: b._id }),
        ]);
        return { ...b.toObject(), service_count: serviceCount, staff_count: staffCount };
      })
    );

    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/branches/:id
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!branch) return res.status(404).json({ message: 'Branch not found' });

    const [services, staff] = await Promise.all([
      BranchService.find({ branch_id: branch._id }).populate('service_id'),
      UserBranch.find({ branch_id: branch._id }).populate('user_id', '-password_hash -pin_hash'),
    ]);

    res.json({ ...branch.toObject(), services, staff });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/branches
router.post('/', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  const { name, branch_code, city, state, address, latitude, longitude, service_ids, staff_ids } = req.body;
  try {
    const branch = await Branch.create({
      business_id: req.user!.businessId,
      name,
      branch_code: branch_code.toUpperCase(),
      city: city || '',
      state: state || '',
      address: address || '',
      latitude: latitude || null,
      longitude: longitude || null,
    });

    if (service_ids?.length) {
      await BranchService.insertMany(
        service_ids.map((sid: string) => ({ branch_id: branch._id, service_id: sid }))
      );
    }
    if (staff_ids?.length) {
      await UserBranch.insertMany(
        staff_ids.map((uid: string) => ({ user_id: uid, branch_id: branch._id }))
      );
    }

    res.status(201).json(branch);
  } catch (err: any) {
    if (err.code === 11000) return res.status(400).json({ message: 'Branch code already exists' });
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/branches/:id
router.put('/:id', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  const { name, branch_code, city, state, address, latitude, longitude } = req.body;
  try {
    const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!branch) return res.status(404).json({ message: 'Branch not found' });

    if (name) branch.name = name;
    if (branch_code) branch.branch_code = branch_code.toUpperCase();
    if (city !== undefined) branch.city = city;
    if (state !== undefined) branch.state = state;
    if (address !== undefined) branch.address = address;
    if (latitude !== undefined) branch.latitude = latitude;
    if (longitude !== undefined) branch.longitude = longitude;
    branch.updatedAt = DateTime.now().toUTC().toISO()!;
    await branch.save();

    res.json(branch);
  } catch (err: any) {
    if (err.code === 11000) return res.status(400).json({ message: 'Branch code already exists' });
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/branches/:id
router.delete('/:id', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  try {
    const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!branch) return res.status(404).json({ message: 'Branch not found' });

    branch.deleted_at = DateTime.now().toUTC().toISO()!;
    await branch.save();

    res.json({ message: 'Branch deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Branch ↔ Services ────────────────────────────────────────────────────────

// GET /api/branches/:id/services
router.get('/:id/services', async (req: AuthRequest, res) => {
  try {
    const links = await BranchService.find({ branch_id: req.params.id }).populate('service_id');
    res.json(links.map((l) => l.service_id));
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/branches/:id/services/:serviceId
router.post('/:id/services/:serviceId', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  try {
    const service = await Service.findOne({ _id: req.params.serviceId, business_id: req.user!.businessId });
    if (!service) return res.status(404).json({ message: 'Service not found' });

    await BranchService.findOneAndUpdate(
      { branch_id: req.params.id, service_id: req.params.serviceId },
      { branch_id: req.params.id, service_id: req.params.serviceId },
      { upsert: true }
    );
    res.json({ message: 'Service linked to branch' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/branches/:id/services/:serviceId
router.delete('/:id/services/:serviceId', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  try {
    await BranchService.deleteOne({ branch_id: req.params.id, service_id: req.params.serviceId });
    res.json({ message: 'Service unlinked from branch' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Branch ↔ Staff ───────────────────────────────────────────────────────────

// GET /api/branches/:id/staff
router.get('/:id/staff', async (req: AuthRequest, res) => {
  try {
    const links = await UserBranch.find({ branch_id: req.params.id }).populate(
      'user_id',
      '-password_hash -pin_hash'
    );
    res.json(links.map((l) => l.user_id));
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/branches/:id/staff/:userId
router.post('/:id/staff/:userId', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  try {
    const user = await User.findOne({ _id: req.params.userId, business_id: req.user!.businessId, deleted_at: null });
    if (!user) return res.status(404).json({ message: 'Staff not found' });

    await UserBranch.findOneAndUpdate(
      { user_id: req.params.userId, branch_id: req.params.id },
      { user_id: req.params.userId, branch_id: req.params.id },
      { upsert: true }
    );
    res.json({ message: 'Staff linked to branch' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/branches/:id/staff/:userId
router.delete('/:id/staff/:userId', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  try {
    await UserBranch.deleteOne({ user_id: req.params.userId, branch_id: req.params.id });
    res.json({ message: 'Staff unlinked from branch' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
