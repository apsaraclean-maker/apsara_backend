import { Router } from 'express';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { Service, BranchService, Article, WashingMethod } from '../models.js';
import { sessionVerification, authorizeRoles, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(sessionVerification);

// GET /api/services
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { search, branch_id, active_only, is_active, article_type, washing_method, min_price, max_price } = req.query;

    const query: any = { business_id: req.user!.businessId, deleted_at: null };
    if (active_only === 'true') query.is_active = true;
    // Services Page filter panel. `is_active` is the tri-state one the panel drives
    // (all / active / inactive); `active_only` above stays for the callers that just want
    // the live catalogue.
    if (is_active === 'true' || is_active === 'false') query.is_active = is_active === 'true';
    if (article_type) query.article_type = article_type;
    if (washing_method) query.washing_method = washing_method;

    // Price range spans both rate fields: a service matches if either the per-piece or the
    // per-kg rate falls in the range, since a service may only carry one of them.
    const priceBound: any = {};
    if (min_price) priceBound.$gte = Number(min_price);
    if (max_price) priceBound.$lte = Number(max_price);
    if (Object.keys(priceBound).length) {
      query.$and = [{ $or: [{ unit_price: priceBound }, { weight_price: priceBound }] }];
    }

    if (search) {
      const escaped = (search as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = { $regex: escaped, $options: 'i' };
      query.$or = [{ name: regex }, { article_type: regex }, { washing_method: regex }];
    }

    let services = await Service.find(query).sort({ name: 1 });

    // Filter by branch if requested
    if (branch_id) {
      const links = await BranchService.find({ branch_id: new mongoose.Types.ObjectId(branch_id as string) }).select('service_id');
      const linkedIds = new Set(links.map((l) => String(l.service_id)));
      services = services.filter((s) => linkedIds.has(String(s._id)));
    }

    // Attach linked branches — the card shows them as tags, and the edit drawer needs
    // them to pre-select the (mandatory) multi-select.
    const allLinks = await BranchService.find({ service_id: { $in: services.map((s) => s._id) } }).populate('branch_id', 'name');
    const linksByService = new Map<string, any[]>();
    for (const link of allLinks) {
      const key = String(link.service_id);
      if (!linksByService.has(key)) linksByService.set(key, []);
      linksByService.get(key)!.push(link.branch_id);
    }

    res.json(services.map((s) => ({ ...s.toObject(), branches: linksByService.get(String(s._id)) || [] })));
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/services/:id
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const service = await Service.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!service) return res.status(404).json({ message: 'Service not found' });
    const links = await BranchService.find({ service_id: service._id }).populate('branch_id', 'name');
    res.json({ ...service.toObject(), branches: links.map((l) => l.branch_id) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/services
router.post('/', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  const { name, article_type, washing_method, unit_price, weight_price, notes, branch_ids } = req.body;
  try {
    if (!Array.isArray(branch_ids) || branch_ids.length === 0) {
      return res.status(400).json({ message: 'Select at least one branch' });
    }
    if (!(Number(unit_price) > 0) && !(Number(weight_price) > 0)) {
      return res.status(400).json({ message: 'Enter a unit price or a weight price' });
    }

    const service = await Service.create({
      business_id: req.user!.businessId,
      name,
      article_type: article_type || '',
      washing_method: washing_method || '',
      unit_price: Number(unit_price) || 0,
      weight_price: Number(weight_price) || 0,
      notes: notes || '',
      is_active: true,
    });

    await BranchService.insertMany(branch_ids.map((bid: string) => ({ branch_id: bid, service_id: service._id })));

    res.status(201).json(service);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/services/:id
router.put('/:id', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  const { name, article_type, washing_method, unit_price, weight_price, notes, branch_ids } = req.body;
  try {
    const service = await Service.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!service) return res.status(404).json({ message: 'Service not found' });

    if (branch_ids !== undefined && (!Array.isArray(branch_ids) || branch_ids.length === 0)) {
      return res.status(400).json({ message: 'Select at least one branch' });
    }

    if (name !== undefined) service.name = name;
    if (article_type !== undefined) service.article_type = article_type;
    if (washing_method !== undefined) service.washing_method = washing_method;
    if (unit_price !== undefined) service.unit_price = Number(unit_price);
    if (weight_price !== undefined) service.weight_price = Number(weight_price);
    if (notes !== undefined) service.notes = notes;
    service.updatedAt = DateTime.now().toUTC().toISO()!;
    await service.save();

    if (branch_ids !== undefined) {
      await BranchService.deleteMany({ service_id: service._id });
      await BranchService.insertMany(branch_ids.map((bid: string) => ({ branch_id: bid, service_id: service._id })));
    }

    res.json(service);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/services/:id/toggle — separate from the owner-only full edit above since
// the PRD lets Manager enable/disable a service without being able to edit its details.
router.patch('/:id/toggle', authorizeRoles('owner', 'manager'), async (req: AuthRequest, res) => {
  const { is_active } = req.body;
  try {
    const service = await Service.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!service) return res.status(404).json({ message: 'Service not found' });

    if (is_active) {
      const branchCount = await BranchService.countDocuments({ service_id: service._id });
      if (branchCount === 0) {
        return res.status(400).json({ message: 'Please link the service to at least one branch to enable' });
      }
    }

    service.is_active = Boolean(is_active);
    service.updatedAt = DateTime.now().toUTC().toISO()!;
    await service.save();
    res.json(service);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/services/:id (soft delete)
router.delete('/:id', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  try {
    const service = await Service.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!service) return res.status(404).json({ message: 'Service not found' });

    service.deleted_at = DateTime.now().toUTC().toISO()!;
    service.updatedAt = DateTime.now().toUTC().toISO()!;
    await service.save();

    // Remove from all branch assignments
    await BranchService.deleteMany({ service_id: service._id });

    res.json({ message: 'Service deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/services/master/articles
router.get('/master/articles', async (_req, res) => {
  try {
    const articles = await Article.find().sort({ name: 1 });
    res.json(articles);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/services/master/washing-methods
router.get('/master/washing-methods', async (_req, res) => {
  try {
    const methods = await WashingMethod.find().sort({ name: 1 });
    res.json(methods);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
