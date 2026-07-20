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
    const { search, branch_id, active_only } = req.query;

    const query: any = { business_id: req.user!.businessId, deleted_at: null };
    if (active_only === 'true') query.is_active = true;

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

    res.json(services);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/services/:id
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const service = await Service.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!service) return res.status(404).json({ message: 'Service not found' });
    res.json(service);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/services
router.post('/', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  const { name, article_type, washing_method, unit_price, weight_price, notes } = req.body;
  try {
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
    res.status(201).json(service);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/services/:id
router.put('/:id', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  const { name, article_type, washing_method, unit_price, weight_price, notes, is_active } = req.body;
  try {
    const service = await Service.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!service) return res.status(404).json({ message: 'Service not found' });

    if (name !== undefined) service.name = name;
    if (article_type !== undefined) service.article_type = article_type;
    if (washing_method !== undefined) service.washing_method = washing_method;
    if (unit_price !== undefined) service.unit_price = Number(unit_price);
    if (weight_price !== undefined) service.weight_price = Number(weight_price);
    if (notes !== undefined) service.notes = notes;
    if (is_active !== undefined) service.is_active = is_active;
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
