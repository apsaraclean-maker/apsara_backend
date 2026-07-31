import { Router } from 'express';
import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import { Branch, BranchService, UserBranch, Service, User, Order, OrderRating } from '../models.js';
import { sessionVerification, authorizeRoles, getAccessibleBranchIds } from '../middleware/auth.js';
import { nowInBusinessTz } from '../utils/timezone.js';
const router = Router();
router.use(sessionVerification);
// Derives a branch code from the branch name: first 3 letters, uppercased. Per the PRD:
// "In case the code already exists, then the 1st letter is skipped for creating the code" —
// i.e. on conflict, skip the first letter and take the *next* 3 letters from the start of
// the name (not the previous shift-the-last-letter-through-the-alphabet scheme this used to
// implement). Repeated conflicts keep skipping one further letter each time.
export function generateBranchCode(name, existingCodes) {
    const letters = name.toUpperCase().replace(/[^A-Z]/g, '');
    const taken = new Set(existingCodes);
    const maxSkip = Math.max(letters.length - 3, 0);
    for (let skip = 0; skip <= maxSkip; skip++) {
        const candidate = letters.slice(skip, skip + 3).padEnd(3, 'X');
        if (!taken.has(candidate))
            return candidate;
    }
    // Name too short to yield more distinct 3-letter windows (or all exhausted) — extremely
    // unlikely in practice. Falls back to a numeric suffix rather than looping forever or
    // silently returning a duplicate (which the unique index would reject anyway).
    const base = (letters.slice(0, 3) || 'BRN').padEnd(3, 'X');
    for (let n = 1; n <= 99; n++) {
        const candidate = `${base.slice(0, 1)}${n.toString().padStart(2, '0')}`;
        if (!taken.has(candidate))
            return candidate;
    }
    return base;
}
// Rough bounding box, not an exact polygon — the PRD only asks that a pin "outside Indian
// territory" be rejected. A handful of border pixels near Pakistan/Nepal/Bangladesh/China/
// Myanmar/Sri Lanka could false-positive as "inside"; an exact polygon check would need a
// real geo dataset, which is out of scope for this validation.
const INDIA_BOUNDS = { minLat: 6.0, maxLat: 37.6, minLng: 68.0, maxLng: 97.5 };
function isWithinIndia(lat, lng) {
    return lat >= INDIA_BOUNDS.minLat && lat <= INDIA_BOUNDS.maxLat && lng >= INDIA_BOUNDS.minLng && lng <= INDIA_BOUNDS.maxLng;
}
function validateBranchFields(body, isCreate) {
    const { name, address_line_1, address_line_2, pincode, city, state, latitude, longitude } = body;
    if (isCreate || name !== undefined) {
        if (!name?.trim())
            return 'Branch name is required';
        if (name.length > 100)
            return 'Branch name cannot exceed 100 characters';
    }
    if (isCreate || address_line_1 !== undefined) {
        if (!address_line_1?.trim())
            return 'Address Line 1 is required';
        if (address_line_1.length > 100)
            return 'Address Line 1 cannot exceed 100 characters';
    }
    if (address_line_2 && address_line_2.length > 100)
        return 'Address Line 2 cannot exceed 100 characters';
    if (isCreate || pincode !== undefined) {
        if (!pincode?.trim())
            return 'Pincode is required';
    }
    if (isCreate || city !== undefined) {
        if (!city?.trim())
            return 'City is required';
    }
    if (isCreate || state !== undefined) {
        if (!state?.trim())
            return 'State is required';
    }
    if (isCreate || latitude !== undefined || longitude !== undefined) {
        if (typeof latitude !== 'number' || typeof longitude !== 'number')
            return 'Branch location is required';
        if (!isWithinIndia(latitude, longitude))
            return 'Pin cannot be in unserviceable Area.';
    }
    return null;
}
// GET /api/branches
router.get('/', async (req, res) => {
    try {
        const { businessId, role } = req.user;
        let branches;
        if (role === 'owner') {
            branches = await Branch.find({ business_id: businessId, deleted_at: null }).sort({ createdAt: -1 });
        }
        else {
            // Managers and workers see only their assigned branches
            const assignments = await UserBranch.find({ user_id: req.user.id }).select('branch_id');
            const branchIds = assignments.map((a) => a.branch_id);
            branches = await Branch.find({ _id: { $in: branchIds }, deleted_at: null }).sort({ createdAt: -1 });
        }
        // Attach service + staff counts, plus the Branch Card's "Revenue & Orders" tag
        // (current calendar month, mirroring /dashboard/stats' convention of filtering by
        // createdAt window + current status rather than a point-in-time history join).
        const monthStart = nowInBusinessTz().startOf('month').toUTC().toISO();
        const enriched = await Promise.all(branches.map(async (b) => {
            const [serviceCount, staffCount, revenueAgg, orderCount, ratingAgg] = await Promise.all([
                BranchService.countDocuments({ branch_id: b._id }),
                UserBranch.countDocuments({ branch_id: b._id }),
                Order.aggregate([
                    { $match: { branch_id: b._id, status: 'paid', createdAt: { $gte: monthStart } } },
                    { $group: { _id: null, total: { $sum: '$total_price' } } },
                ]),
                Order.countDocuments({ branch_id: b._id, deleted_at: null, createdAt: { $gte: monthStart } }),
                OrderRating.aggregate([
                    { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
                    { $unwind: '$order' },
                    { $match: { 'order.branch_id': new mongoose.Types.ObjectId(b._id), submitted_at: { $ne: null } } },
                    { $group: { _id: null, avg: { $avg: '$overall_rating' } } },
                ]),
            ]);
            return {
                ...b.toObject(),
                service_count: serviceCount,
                staff_count: staffCount,
                monthly_revenue: revenueAgg[0]?.total || 0,
                monthly_orders: orderCount,
                rating: ratingAgg[0]?.avg ? Math.round(ratingAgg[0].avg * 10) / 10 : null,
            };
        }));
        res.json(enriched);
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// GET /api/branches/:id
router.get('/:id', async (req, res) => {
    try {
        const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user.businessId, deleted_at: null });
        if (!branch)
            return res.status(404).json({ message: 'Branch not found' });
        const accessible = await getAccessibleBranchIds(req.user);
        if (accessible !== null && !accessible.includes(String(branch._id))) {
            return res.status(403).json({ message: 'Access to this branch is not permitted' });
        }
        const [services, staff] = await Promise.all([
            BranchService.find({ branch_id: branch._id }).populate('service_id'),
            UserBranch.find({ branch_id: branch._id }).populate('user_id', '-password_hash -pin_encrypted'),
        ]);
        res.json({ ...branch.toObject(), services, staff });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// POST /api/branches
router.post('/', authorizeRoles('owner'), async (req, res) => {
    const { name, address_line_1, address_line_2, pincode, city, state, latitude, longitude, service_ids, staff_ids } = req.body;
    try {
        const validationError = validateBranchFields(req.body, true);
        if (validationError)
            return res.status(400).json({ message: validationError });
        const existing = await Branch.find({ business_id: req.user.businessId, deleted_at: null }).select('branch_code');
        const branch_code = generateBranchCode(name, existing.map((b) => b.branch_code));
        const branch = await Branch.create({
            business_id: req.user.businessId,
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
            await BranchService.insertMany(service_ids.map((sid) => ({ branch_id: branch._id, service_id: sid })));
        }
        if (staff_ids?.length) {
            await UserBranch.insertMany(staff_ids.map((uid) => ({ user_id: uid, branch_id: branch._id })));
        }
        res.status(201).json(branch);
    }
    catch (err) {
        if (err.code === 11000)
            return res.status(400).json({ message: 'Branch code already exists' });
        res.status(500).json({ message: err.message });
    }
});
// PUT /api/branches/:id
router.put('/:id', authorizeRoles('owner'), async (req, res) => {
    const { name, branch_code, address_line_1, address_line_2, pincode, city, state, latitude, longitude } = req.body;
    try {
        const validationError = validateBranchFields(req.body, false);
        if (validationError)
            return res.status(400).json({ message: validationError });
        const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user.businessId, deleted_at: null });
        if (!branch)
            return res.status(404).json({ message: 'Branch not found' });
        if (name)
            branch.name = name;
        if (branch_code)
            branch.branch_code = branch_code.toUpperCase();
        if (address_line_1 !== undefined)
            branch.address_line_1 = address_line_1;
        if (address_line_2 !== undefined)
            branch.address_line_2 = address_line_2;
        if (pincode !== undefined)
            branch.pincode = pincode;
        if (city !== undefined)
            branch.city = city;
        if (state !== undefined)
            branch.state = state;
        if (latitude !== undefined)
            branch.latitude = latitude;
        if (longitude !== undefined)
            branch.longitude = longitude;
        branch.updatedAt = DateTime.now().toUTC().toISO();
        await branch.save();
        res.json(branch);
    }
    catch (err) {
        if (err.code === 11000)
            return res.status(400).json({ message: 'Branch code already exists' });
        res.status(500).json({ message: err.message });
    }
});
// DELETE /api/branches/:id
router.delete('/:id', authorizeRoles('owner'), async (req, res) => {
    try {
        const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user.businessId, deleted_at: null });
        if (!branch)
            return res.status(404).json({ message: 'Branch not found' });
        // A business must always have at least one branch — without one, it has no way to
        // create orders/services/staff assignments at all. Registration guarantees every
        // business starts with a branch (see auth.ts#register-business); this guarantees it
        // never drops back down to zero.
        const branchCount = await Branch.countDocuments({ business_id: req.user.businessId, deleted_at: null });
        if (branchCount <= 1) {
            return res.status(400).json({ message: 'A business must have at least one branch — create another branch before deleting this one.' });
        }
        branch.deleted_at = DateTime.now().toUTC().toISO();
        await branch.save();
        // PRD: "All orders connected to this branch also gets deleted." Soft-deletes them
        // (deleted_at, same as the single-order DELETE route) rather than hard-deleting, so
        // they're still swept by Phase 8's eventual 3-month hard-delete purge job — consistent
        // with every other delete in this app, and avoids losing the audit trail immediately.
        await Order.updateMany({ branch_id: branch._id, business_id: req.user.businessId, deleted_at: null }, { deleted_at: DateTime.now().toUTC().toISO() });
        // PRD: "the link of staff and service to this branch gets disconnected."
        const affectedServiceLinks = await BranchService.find({ branch_id: branch._id }).select('service_id');
        const affectedServiceIds = affectedServiceLinks.map((l) => l.service_id);
        const affectedStaffLinks = await UserBranch.find({ branch_id: branch._id }).select('user_id');
        const affectedStaffIds = affectedStaffLinks.map((l) => l.user_id);
        await BranchService.deleteMany({ branch_id: branch._id });
        await UserBranch.deleteMany({ branch_id: branch._id });
        // Services/staff left with zero remaining branch links get disabled until re-linked
        // (both PRD edge cases — Services Page's and Staff Page's — are the same cascade).
        for (const serviceId of affectedServiceIds) {
            const remaining = await BranchService.countDocuments({ service_id: serviceId });
            if (remaining === 0) {
                await Service.findByIdAndUpdate(serviceId, { is_active: false, updatedAt: DateTime.now().toUTC().toISO() });
            }
        }
        for (const userId of affectedStaffIds) {
            const remaining = await UserBranch.countDocuments({ user_id: userId });
            if (remaining === 0) {
                await User.findByIdAndUpdate(userId, { is_active: false, updatedAt: DateTime.now().toUTC().toISO() });
            }
        }
        res.json({ message: 'Branch deleted successfully' });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// ─── Branch ↔ Services ────────────────────────────────────────────────────────
// Verifies the branch exists within the caller's own business AND (for managers/workers)
// that they're actually assigned to it. Previously these branch-scoped sub-resource routes
// had no such check at all — not even a business_id scope — so any authenticated user of
// *any* business could pass an arbitrary branch id from a different business entirely and
// read its linked services/staff.
async function verifyBranchAccess(req, branchId) {
    const branch = await Branch.findOne({ _id: branchId, business_id: req.user.businessId, deleted_at: null });
    if (!branch)
        return false;
    const accessible = await getAccessibleBranchIds(req.user);
    if (accessible !== null && !accessible.includes(String(branch._id)))
        return false;
    return true;
}
// GET /api/branches/:id/services
router.get('/:id/services', async (req, res) => {
    try {
        if (!(await verifyBranchAccess(req, req.params.id))) {
            return res.status(403).json({ message: 'Access to this branch is not permitted' });
        }
        const links = await BranchService.find({ branch_id: req.params.id }).populate('service_id');
        res.json(links.map((l) => l.service_id));
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// POST /api/branches/:id/services/:serviceId
router.post('/:id/services/:serviceId', authorizeRoles('owner'), async (req, res) => {
    try {
        const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user.businessId, deleted_at: null });
        if (!branch)
            return res.status(404).json({ message: 'Branch not found' });
        const service = await Service.findOne({ _id: req.params.serviceId, business_id: req.user.businessId });
        if (!service)
            return res.status(404).json({ message: 'Service not found' });
        await BranchService.findOneAndUpdate({ branch_id: req.params.id, service_id: req.params.serviceId }, { branch_id: req.params.id, service_id: req.params.serviceId }, { upsert: true });
        res.json({ message: 'Service linked to branch' });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// DELETE /api/branches/:id/services/:serviceId
router.delete('/:id/services/:serviceId', authorizeRoles('owner'), async (req, res) => {
    try {
        const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user.businessId, deleted_at: null });
        if (!branch)
            return res.status(404).json({ message: 'Branch not found' });
        await BranchService.deleteOne({ branch_id: req.params.id, service_id: req.params.serviceId });
        res.json({ message: 'Service unlinked from branch' });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// ─── Branch ↔ Staff ───────────────────────────────────────────────────────────
// GET /api/branches/:id/staff
router.get('/:id/staff', async (req, res) => {
    try {
        if (!(await verifyBranchAccess(req, req.params.id))) {
            return res.status(403).json({ message: 'Access to this branch is not permitted' });
        }
        const links = await UserBranch.find({ branch_id: req.params.id }).populate('user_id', '-password_hash -pin_encrypted');
        res.json(links.map((l) => l.user_id));
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// POST /api/branches/:id/staff/:userId
router.post('/:id/staff/:userId', authorizeRoles('owner'), async (req, res) => {
    try {
        const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user.businessId, deleted_at: null });
        if (!branch)
            return res.status(404).json({ message: 'Branch not found' });
        const user = await User.findOne({ _id: req.params.userId, business_id: req.user.businessId, deleted_at: null });
        if (!user)
            return res.status(404).json({ message: 'Staff not found' });
        await UserBranch.findOneAndUpdate({ user_id: req.params.userId, branch_id: req.params.id }, { user_id: req.params.userId, branch_id: req.params.id }, { upsert: true });
        res.json({ message: 'Staff linked to branch' });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// DELETE /api/branches/:id/staff/:userId
router.delete('/:id/staff/:userId', authorizeRoles('owner'), async (req, res) => {
    try {
        const branch = await Branch.findOne({ _id: req.params.id, business_id: req.user.businessId, deleted_at: null });
        if (!branch)
            return res.status(404).json({ message: 'Branch not found' });
        await UserBranch.deleteOne({ user_id: req.params.userId, branch_id: req.params.id });
        res.json({ message: 'Staff unlinked from branch' });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
export default router;
