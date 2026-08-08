import { Router } from 'express';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { Branch, BranchService, UserBranch, Service, User, Order, OrderRating } from '../models.js';
import { sessionVerification, authorizeRoles, getAccessibleBranchIds, type AuthRequest } from '../middleware/auth.js';
import { nowInBusinessTz } from '../utils/timezone.js';
import { invalidateUserContexts } from '../utils/authCache.js';

const router = Router();
router.use(sessionVerification);

// Derives a branch code from the branch name: first 3 letters, uppercased. Per the PRD:
// "In case the code already exists, then the 1st letter is skipped for creating the code" —
// i.e. on conflict, skip the first letter and take the *next* 3 letters from the start of
// the name (not the previous shift-the-last-letter-through-the-alphabet scheme this used to
// implement). Repeated conflicts keep skipping one further letter each time.
export function generateBranchCode(name: string, existingCodes: string[]): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, '');
  const taken = new Set(existingCodes);

  const maxSkip = Math.max(letters.length - 3, 0);
  for (let skip = 0; skip <= maxSkip; skip++) {
    const candidate = letters.slice(skip, skip + 3).padEnd(3, 'X');
    if (!taken.has(candidate)) return candidate;
  }

  // Name too short to yield more distinct 3-letter windows (or all exhausted) — extremely
  // unlikely in practice. Falls back to a numeric suffix rather than looping forever or
  // silently returning a duplicate (which the unique index would reject anyway).
  const base = (letters.slice(0, 3) || 'BRN').padEnd(3, 'X');
  for (let n = 1; n <= 99; n++) {
    const candidate = `${base.slice(0, 1)}${n.toString().padStart(2, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

// Rough bounding box, not an exact polygon — the PRD only asks that a pin "outside Indian
// territory" be rejected. A handful of border pixels near Pakistan/Nepal/Bangladesh/China/
// Myanmar/Sri Lanka could false-positive as "inside"; an exact polygon check would need a
// real geo dataset, which is out of scope for this validation.
const INDIA_BOUNDS = { minLat: 6.0, maxLat: 37.6, minLng: 68.0, maxLng: 97.5 };
function isWithinIndia(lat: number, lng: number): boolean {
  return lat >= INDIA_BOUNDS.minLat && lat <= INDIA_BOUNDS.maxLat && lng >= INDIA_BOUNDS.minLng && lng <= INDIA_BOUNDS.maxLng;
}

function validateBranchFields(body: any, isCreate: boolean): string | null {
  const { name, address_line_1, address_line_2, pincode, city, state, latitude, longitude } = body;
  if (isCreate || name !== undefined) {
    if (!name?.trim()) return 'Branch name is required';
    if (name.length > 100) return 'Branch name cannot exceed 100 characters';
  }
  if (isCreate || address_line_1 !== undefined) {
    if (!address_line_1?.trim()) return 'Address Line 1 is required';
    if (address_line_1.length > 100) return 'Address Line 1 cannot exceed 100 characters';
  }
  if (address_line_2 && address_line_2.length > 100) return 'Address Line 2 cannot exceed 100 characters';
  if (isCreate || pincode !== undefined) {
    if (!pincode?.trim()) return 'Pincode is required';
  }
  if (isCreate || city !== undefined) {
    if (!city?.trim()) return 'City is required';
  }
  if (isCreate || state !== undefined) {
    if (!state?.trim()) return 'State is required';
  }
  if (isCreate || latitude !== undefined || longitude !== undefined) {
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return 'Branch location is required';
    if (!isWithinIndia(latitude, longitude)) return 'Pin cannot be in unserviceable Area.';
  }
  return null;
}

// GET /api/branches
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { businessId, role } = req.user!;
    let branches;

    if (role === 'owner') {
      branches = await Branch.find({ business_id: businessId, deleted_at: null }).sort({ createdAt: -1 }).lean();
    } else {
      // Managers and workers see only their assigned branches. The assignment list already
      // rode in on the session context (see middleware/auth.ts), so this no longer costs its
      // own round trip.
      const accessible = await getAccessibleBranchIds(req.user!);
      branches = await Branch.find({
        _id: { $in: (accessible ?? []).map((id) => new mongoose.Types.ObjectId(id)) },
        deleted_at: null,
      })
        .sort({ createdAt: -1 })
        .lean();
    }

    // Attach service + staff counts, plus the Branch Card's "Revenue & Orders" tag
    // (current calendar month, mirroring /dashboard/stats' convention of filtering by
    // createdAt window + current status rather than a point-in-time history join).
    //
    // Four aggregates for the whole list, grouped by branch. This used to run five queries
    // per branch inside branches.map(async …), so ten branches meant fifty round trips.
    // The rating one was the expensive part: it started from OrderRating and $lookup'd the
    // entire orders collection, once per branch, with nothing indexable to narrow it. It's
    // inverted here to start from Order — where branch_id is indexed — so the $lookup runs
    // against the already-narrowed set and rides OrderRating's unique order_id index.
    const monthStart = nowInBusinessTz().startOf('month').toJSDate();
    const branchIds = branches.map((b) => b._id);

    const [serviceCounts, staffCounts, monthlyAgg, ratingAgg] = await Promise.all([
      BranchService.aggregate<{ _id: any; count: number }>([
        { $match: { branch_id: { $in: branchIds } } },
        { $group: { _id: '$branch_id', count: { $sum: 1 } } },
      ]),
      UserBranch.aggregate<{ _id: any; count: number }>([
        { $match: { branch_id: { $in: branchIds } } },
        { $group: { _id: '$branch_id', count: { $sum: 1 } } },
      ]),
      // Revenue and order count in one pass. The two used to disagree about soft-deleted
      // orders — revenue counted them, the order count didn't — so the $cond arms preserve
      // each one's original filter exactly rather than quietly changing either number.
      Order.aggregate<{ _id: any; revenue: number; orders: number }>([
        { $match: { branch_id: { $in: branchIds }, createdAt: { $gte: monthStart } } },
        {
          $group: {
            _id: '$branch_id',
            revenue: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$total_price', 0] } },
            orders: { $sum: { $cond: [{ $eq: ['$deleted_at', null] }, 1, 0] } },
          },
        },
      ]),
      // Inverted relative to the revenue rollup: this one starts from the *ratings* side,
      // narrowed by the indexed submitted_at, and joins back to orders to pick up branch_id.
      //
      // Starting from Order meant matching every order these branches had ever taken — with
      // no date bound at all — and running a $lookup into orderratings for each one, purely
      // to discover that the overwhelming majority have no rating. Submitted ratings are a
      // small fraction of orders, so entering from that side does a fraction of the work.
      OrderRating.aggregate<{ _id: any; avg: number }>([
        { $match: { submitted_at: { $ne: null } } },
        {
          $lookup: {
            from: 'orders',
            localField: 'order_id',
            foreignField: '_id',
            as: 'order',
            pipeline: [
              { $match: { branch_id: { $in: branchIds } } },
              { $project: { branch_id: 1 } },
            ],
          },
        },
        { $unwind: '$order' },
        { $group: { _id: '$order.branch_id', avg: { $avg: '$overall_rating' } } },
      ]),
    ]);

    const byId = <T extends { _id: any }>(rows: T[]) => new Map(rows.map((r) => [String(r._id), r]));
    const serviceById = byId(serviceCounts);
    const staffById = byId(staffCounts);
    const monthlyById = byId(monthlyAgg);
    const ratingById = byId(ratingAgg);

    const enriched = branches.map((b) => {
      const key = String(b._id);
      const monthly = monthlyById.get(key);
      const avg = ratingById.get(key)?.avg;
      return {
        ...b,
        service_count: serviceById.get(key)?.count ?? 0,
        staff_count: staffById.get(key)?.count ?? 0,
        monthly_revenue: monthly?.revenue ?? 0,
        monthly_orders: monthly?.orders ?? 0,
        rating: avg ? Math.round(avg * 10) / 10 : null,
      };
    });

    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/branches/:id
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null }).lean();
    if (!branch) return res.status(404).json({ message: 'Branch not found' });

    const accessible = await getAccessibleBranchIds(req.user!);
    if (accessible !== null && !accessible.includes(String(branch._id))) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }

    const [services, staff] = await Promise.all([
      BranchService.find({ branch_id: branch._id }).populate('service_id').lean(),
      UserBranch.find({ branch_id: branch._id }).populate('user_id', '-password_hash -pin_encrypted').lean(),
    ]);

    res.json({ ...branch, services, staff });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/branches
router.post('/', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  const { name, address_line_1, address_line_2, pincode, city, state, latitude, longitude, service_ids, staff_ids } = req.body;
  try {
    const validationError = validateBranchFields(req.body, true);
    if (validationError) return res.status(400).json({ message: validationError });

    const existing = await Branch.find({ business_id: req.user!.businessId, deleted_at: null }).select('branch_code');
    const branch_code = generateBranchCode(name, existing.map((b) => b.branch_code));

    const branch = await Branch.create({
      business_id: req.user!.businessId,
      name,
      branch_code,
      address_line_1,
      address_line_2: address_line_2 || '',
      pincode,
      city,
      state,
      latitude,
      longitude,
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
      // Their accessible-branch set just widened; drop the cached copy.
      await invalidateUserContexts(staff_ids);
    }

    res.status(201).json(branch);
  } catch (err: any) {
    if (err.code === 11000) return res.status(400).json({ message: 'Branch code already exists' });
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/branches/:id
router.put('/:id', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  const { name, branch_code, address_line_1, address_line_2, pincode, city, state, latitude, longitude } = req.body;
  try {
    const validationError = validateBranchFields(req.body, false);
    if (validationError) return res.status(400).json({ message: validationError });

    const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!branch) return res.status(404).json({ message: 'Branch not found' });

    if (name) branch.name = name;
    if (branch_code) branch.branch_code = branch_code.toUpperCase();
    if (address_line_1 !== undefined) branch.address_line_1 = address_line_1;
    if (address_line_2 !== undefined) branch.address_line_2 = address_line_2;
    if (pincode !== undefined) branch.pincode = pincode;
    if (city !== undefined) branch.city = city;
    if (state !== undefined) branch.state = state;
    if (latitude !== undefined) branch.latitude = latitude;
    if (longitude !== undefined) branch.longitude = longitude;
    branch.updatedAt = DateTime.now().toUTC().toJSDate();
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

    // A business must always have at least one branch — without one, it has no way to
    // create orders/services/staff assignments at all. Registration guarantees every
    // business starts with a branch (see auth.ts#register-business); this guarantees it
    // never drops back down to zero.
    const branchCount = await Branch.countDocuments({ business_id: req.user!.businessId, deleted_at: null });
    if (branchCount <= 1) {
      return res.status(400).json({ message: 'A business must have at least one branch — create another branch before deleting this one.' });
    }

    const now = DateTime.now().toUTC().toJSDate();
    branch.deleted_at = now;
    await branch.save();

    // Collect what's linked before the links are removed. Both reads and the order cascade
    // are independent of one another.
    const [affectedServiceLinks, affectedStaffLinks] = await Promise.all([
      BranchService.find({ branch_id: branch._id }).select('service_id').lean(),
      UserBranch.find({ branch_id: branch._id }).select('user_id').lean(),
      // PRD: "All orders connected to this branch also gets deleted." Soft-deletes them
      // (deleted_at, same as the single-order DELETE route) rather than hard-deleting, so
      // they're still swept by Phase 8's eventual 3-month hard-delete purge job — consistent
      // with every other delete in this app, and avoids losing the audit trail immediately.
      Order.updateMany(
        { branch_id: branch._id, business_id: req.user!.businessId, deleted_at: null },
        { deleted_at: now }
      ),
    ]);
    const affectedServiceIds = affectedServiceLinks.map((l) => l.service_id);
    const affectedStaffIds = affectedStaffLinks.map((l) => l.user_id);

    // PRD: "the link of staff and service to this branch gets disconnected."
    await Promise.all([
      BranchService.deleteMany({ branch_id: branch._id }),
      UserBranch.deleteMany({ branch_id: branch._id }),
    ]);

    // Services/staff left with zero remaining branch links get disabled until re-linked
    // (both PRD edge cases — Services Page's and Staff Page's — are the same cascade).
    //
    // This was a countDocuments per affected service and per affected user, each awaited in
    // turn, followed by an individual update for every one that came back zero: deleting a
    // branch with 30 services and 20 staff cost 50 sequential round trips before any update
    // ran. Two grouped reads now say which ids still have links anywhere, and the complement
    // is disabled in a single updateMany each.
    const [remainingServiceLinks, remainingStaffLinks] = await Promise.all([
      BranchService.aggregate<{ _id: any }>([
        { $match: { service_id: { $in: affectedServiceIds } } },
        { $group: { _id: '$service_id' } },
      ]),
      UserBranch.aggregate<{ _id: any }>([
        { $match: { user_id: { $in: affectedStaffIds } } },
        { $group: { _id: '$user_id' } },
      ]),
    ]);

    const stillLinkedServices = new Set(remainingServiceLinks.map((r) => String(r._id)));
    const orphanedServiceIds = affectedServiceIds.filter((id) => !stillLinkedServices.has(String(id)));
    const stillLinkedStaff = new Set(remainingStaffLinks.map((r) => String(r._id)));
    const orphanedStaffIds = affectedStaffIds.filter((id) => !stillLinkedStaff.has(String(id)));

    await Promise.all([
      orphanedServiceIds.length
        ? Service.updateMany({ _id: { $in: orphanedServiceIds } }, { is_active: false, updatedAt: now })
        : Promise.resolve(),
      orphanedStaffIds.length
        ? User.updateMany({ _id: { $in: orphanedStaffIds } }, { is_active: false, updatedAt: now })
        : Promise.resolve(),
    ]);

    // Every staff member who was linked here just had their accessible-branch set change, and
    // for the orphaned ones their active flag too — both are cached by sessionVerification,
    // so the cache has to be dropped or they'd keep the old view for up to a minute.
    await invalidateUserContexts(affectedStaffIds);

    res.json({ message: 'Branch deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Branch ↔ Services ────────────────────────────────────────────────────────

// Verifies the branch exists within the caller's own business AND (for managers/workers)
// that they're actually assigned to it. Previously these branch-scoped sub-resource routes
// had no such check at all — not even a business_id scope — so any authenticated user of
// *any* business could pass an arbitrary branch id from a different business entirely and
// read its linked services/staff.
async function verifyBranchAccess(req: AuthRequest, branchId: string): Promise<boolean> {
  const branch = await Branch.findOne({ _id: branchId, business_id: req.user!.businessId, deleted_at: null });
  if (!branch) return false;
  const accessible = await getAccessibleBranchIds(req.user!);
  if (accessible !== null && !accessible.includes(String(branch._id))) return false;
  return true;
}

// GET /api/branches/:id/services
router.get('/:id/services', async (req: AuthRequest, res) => {
  try {
    if (!(await verifyBranchAccess(req, req.params.id))) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }
    const links = await BranchService.find({ branch_id: req.params.id }).populate('service_id').lean();
    res.json(links.map((l) => l.service_id));
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/branches/:id/services/:serviceId
router.post('/:id/services/:serviceId', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  try {
    const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!branch) return res.status(404).json({ message: 'Branch not found' });
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
    const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!branch) return res.status(404).json({ message: 'Branch not found' });

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
    if (!(await verifyBranchAccess(req, req.params.id))) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }
    const links = await UserBranch.find({ branch_id: req.params.id })
      .populate('user_id', '-password_hash -pin_encrypted')
      .lean();
    res.json(links.map((l) => l.user_id));
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/branches/:id/staff/:userId
router.post('/:id/staff/:userId', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  try {
    const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!branch) return res.status(404).json({ message: 'Branch not found' });
    const user = await User.findOne({ _id: req.params.userId, business_id: req.user!.businessId, deleted_at: null });
    if (!user) return res.status(404).json({ message: 'Staff not found' });

    await UserBranch.findOneAndUpdate(
      { user_id: req.params.userId, branch_id: req.params.id },
      { user_id: req.params.userId, branch_id: req.params.id },
      { upsert: true }
    );
    await invalidateUserContexts([req.params.userId]);
    res.json({ message: 'Staff linked to branch' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/branches/:id/staff/:userId
router.delete('/:id/staff/:userId', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  try {
    const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!branch) return res.status(404).json({ message: 'Branch not found' });

    await UserBranch.deleteOne({ user_id: req.params.userId, branch_id: req.params.id });
    await invalidateUserContexts([req.params.userId]);
    res.json({ message: 'Staff unlinked from branch' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
