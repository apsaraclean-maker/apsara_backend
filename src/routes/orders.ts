import { Router } from 'express';
import { DateTime } from 'luxon';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import mongoose from 'mongoose';
import crypto from 'crypto';
import {
  Order,
  OrderService,
  OrderImage,
  OrderStatusHistory,
  OrderRating,
  OrderDailyCounter,
  Service,
  Branch,
  User,
} from '../models.js';
import { sessionVerification, authorizeRoles, getAccessibleBranchIds, type AuthRequest } from '../middleware/auth.js';
import { buildWhatsAppMessage, type WhatsAppEvent } from '../services/whatsapp.js';
import { isOrderDelayed, delayedMatchCondition } from '../utils/orderDelay.js';
import { nowInBusinessTz, parseDateInBusinessTz } from '../utils/timezone.js';

// True if the caller (already business-scoped by whatever lookup found `order`) is also
// allowed to touch this specific order's branch (owners are unrestricted; managers/workers
// are limited to their UserBranch assignments). Keep the null-check on `order` as a
// separate `if (!order) return ...` at each call site so TypeScript still narrows it.
async function hasOrderBranchAccess(user: AuthRequest['user'], order: { branch_id: any }): Promise<boolean> {
  const accessible = await getAccessibleBranchIds(user!);
  if (accessible === null) return true;
  const branchId = String(order.branch_id?._id ?? order.branch_id);
  return accessible.includes(branchId);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, '..', '..', 'uploads');

const storage = multer.diskStorage({
  destination: (req: any, _file, cb) => {
    const businessId = req.user?.businessId;
    if (!businessId) return cb(new Error('Business ID missing'), '');
    const dir = path.join(uploadsDir, 'orders', `business_${businessId}`);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${file.fieldname}-${unique}${path.extname(file.originalname)}`);
  },
});

// Anchored extension check (was an unanchored substring test — `image.jpegx` would have
// matched `/jpeg|jpg|png|webp/` since it contains "jpeg") plus an exact mimetype allowlist
// (was the same unanchored regex against the client-supplied, spoofable mimetype string).
const ALLOWED_IMAGE_EXT = /^\.(jpeg|jpg|png|webp)$/i;
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_EXT.test(path.extname(file.originalname)) && ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only images (jpeg, jpg, png, webp) are allowed'));
    }
  },
});

const router = Router();

// ─── Public rating/invoice routes ──────────────────────────────────────────────
// Registered before `router.use(sessionVerification)` below — this page is meant to be
// reachable by an anonymous customer clicking a WhatsApp link, with the 192-bit
// `rating_token` itself acting as the access control, not a login session. Previously
// these were defined *after* the sessionVerification middleware on this same router, which
// meant every request to them was rejected with 401 before ever reaching the handler —
// the entire public rating/invoice page was non-functional for real, unauthenticated
// customers. Express applies middleware/routes in registration order per request, so
// moving these two above the `.use()` call is what actually makes them public.

// GET /api/orders/rate/:token
router.get('/rate/:token', async (req, res) => {
  try {
    const rating = await OrderRating.findOne({ rating_token: req.params.token });
    if (!rating) return res.status(404).json({ message: 'Rating link not found or expired' });

    // deleted_at check matters here: every other order-reading route filters it out, but
    // this one previously didn't — a soft-deleted order's rating link stayed fully
    // browsable (and rateable) indefinitely. Reuses the same "not found or expired" message
    // as a missing token so a deleted order isn't distinguishable from a bad link.
    const order = await Order.findOne({ _id: rating.order_id, deleted_at: null })
      .populate('branch_id', 'name address_line_1 address_line_2 city state pincode')
      // The invoice header prints the shop's address and phone under its name, so the
      // whole block travels with the order rather than just the name.
      .populate('business_id', 'name address state pincode phone');
    if (!order) return res.status(404).json({ message: 'Rating link not found or expired' });

    const items = await OrderService.find({ order_id: order._id });

    res.json({
      order: { ...order.toObject(), items },
      rating: {
        submitted: rating.submitted_at !== null,
        overall_rating: rating.overall_rating,
        speed_rating: rating.speed_rating,
        quality_rating: rating.quality_rating,
      },
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/orders/rate/:token
router.post('/rate/:token', async (req, res) => {
  const { overall_rating, speed_rating, quality_rating } = req.body;
  const isValidRating = (v: any) => v === undefined || (Number.isInteger(v) && v >= 1 && v <= 5);
  if (!Number.isInteger(overall_rating) || overall_rating < 1 || overall_rating > 5) {
    return res.status(400).json({ message: 'overall_rating must be an integer from 1 to 5' });
  }
  if (!isValidRating(speed_rating) || !isValidRating(quality_rating)) {
    return res.status(400).json({ message: 'Ratings must be an integer from 1 to 5' });
  }
  try {
    const rating = await OrderRating.findOne({ rating_token: req.params.token });
    if (!rating) return res.status(404).json({ message: 'Rating link not found or expired' });
    const order = await Order.findOne({ _id: rating.order_id, deleted_at: null }).select('_id');
    if (!order) return res.status(404).json({ message: 'Rating link not found or expired' });
    if (rating.submitted_at) return res.status(400).json({ message: 'Rating already submitted' });

    rating.overall_rating = overall_rating;
    rating.speed_rating = speed_rating;
    rating.quality_rating = quality_rating;
    rating.submitted_at = DateTime.now().toUTC().toISO()!;
    await rating.save();

    res.json({ message: 'Thank you for your rating!' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.use(sessionVerification);

// The status progress bar only ever moves one adjacent step at a time (forward via
// stepForward/stepBackward), cancels from created/in_progress only, and reopens a cancelled
// order straight back to created (Order Detail Page, orders/[id]/page.tsx) — but the API
// itself never enforced any of that, so a direct call could e.g. cancel a paid order or jump
// straight from created to paid. This mirrors the frontend's actual button-permitted set
// exactly (no more, no less) rather than inventing a stricter rule the UI doesn't need.
const STATUS_STEPS = ['created', 'in_progress', 'completed', 'paid'];
function isValidStatusTransition(from: string, to: string): boolean {
  if (from === to) return false;
  if (from === 'cancelled') return to === 'created'; // reopen
  if (to === 'cancelled') return from === 'created' || from === 'in_progress'; // cancel
  const fromIdx = STATUS_STEPS.indexOf(from);
  const toIdx = STATUS_STEPS.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  return Math.abs(fromIdx - toIdx) === 1;
}

// Order number format: {branchCode}-{employeeId}-{YYMMDD}-{counter}, counter is base-36
// (001-ZZZ), reset daily per branch. Matches the PRD's Order Card UI calculation logic
// (e.g. #DOD-AP0-260612-048).
async function getNextOrderNumber(branchId: string, branchCode: string, employeeId: string): Promise<string> {
  const today = nowInBusinessTz().toFormat('yyMMdd');
  const counter = await OrderDailyCounter.findOneAndUpdate(
    { branch_id: branchId, order_date: today },
    { $inc: { last_counter: 1 } },
    { upsert: true, new: true }
  );
  const seq = counter.last_counter.toString(36).toUpperCase().padStart(3, '0');
  return `${branchCode}-${employeeId}-${today}-${seq}`;
}

// GET /api/orders
router.get('/', async (req: AuthRequest, res) => {
  try {
    const {
      status, branch_id, start_date, end_date, search, is_delayed,
      service_id, min_price, max_price, created_by,
      timeline_date, timeline_status, include_history,
      page = '1', limit = '20', sort = 'created_desc',
    } = req.query;
    // Order Timeline click-through: filter to exactly the orders the clicked cell counted,
    // instead of the broad generic date-range below (which would over-match, e.g. a paid
    // order created on that day but paid on a different day). Mutually exclusive with the
    // generic date-range/status path.
    const timelineMode = !!(timeline_date && timeline_status);
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    // PRD: Order Quickview shows a max of 200 cards.
    const limitNum = Math.min(parseInt(limit as string) || 20, 200);

    const match: any = { business_id: new mongoose.Types.ObjectId(req.user!.businessId!), deleted_at: null };

    if (status) match.status = status;
    if (created_by) match.created_by = new mongoose.Types.ObjectId(created_by as string);

    if (min_price || max_price) {
      match.total_price = {};
      if (min_price) match.total_price.$gte = Number(min_price);
      if (max_price) match.total_price.$lte = Number(max_price);
    }

    if (service_id) {
      const orderIdsWithService = await OrderService.find({ service_id: service_id as string }).distinct('order_id');
      match._id = { $in: orderIdsWithService };
    }

    const accessibleBranchIds = await getAccessibleBranchIds(req.user!);
    if (accessibleBranchIds === null) {
      if (branch_id) match.branch_id = new mongoose.Types.ObjectId(branch_id as string);
    } else if (branch_id) {
      if (!accessibleBranchIds.includes(branch_id as string)) {
        return res.status(403).json({ message: 'Access to this branch is not permitted' });
      }
      match.branch_id = new mongoose.Types.ObjectId(branch_id as string);
    } else {
      match.branch_id = { $in: accessibleBranchIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }

    // Date range matches an order if it was created, is due, or had any status transition
    // in the window (per the PRD's Order Quickview date-range semantics) — combined with
    // `search` via a top-level $and since both need their own $or.
    const andConditions: any[] = [];

    if (timelineMode) {
      // Replicate the Order Timeline cell's exact counting semantics (see
      // dashboard.ts GET /timeline) for a single business-day so the resulting list
      // reconciles 1:1 with the count that was clicked:
      //   created   → created that day, not currently cancelled
      //   order_due → due that day, not currently cancelled
      //   completed → a 'completed' history entry that day, still completed-or-paid now
      //   paid      → a 'paid' history entry that day, still paid now
      //   cancelled → a 'cancelled' history entry that day (terminal)
      const dayStart = parseDateInBusinessTz(timeline_date as string).startOf('day').toUTC().toISO()!;
      const dayEnd = parseDateInBusinessTz(timeline_date as string).endOf('day').toUTC().toISO()!;
      const ts = timeline_status as string;

      if (ts === 'created') {
        match.status = { $ne: 'cancelled' };
        andConditions.push({ createdAt: { $gte: dayStart, $lte: dayEnd } });
      } else if (ts === 'order_due') {
        match.status = { $ne: 'cancelled' };
        andConditions.push({ delivery_due_date: { $gte: dayStart, $lte: dayEnd } });
      } else if (ts === 'completed' || ts === 'paid' || ts === 'cancelled') {
        const orderIds = await OrderStatusHistory.find({
          status: ts,
          changed_at: { $gte: dayStart, $lte: dayEnd },
        }).distinct('order_id');
        andConditions.push({ _id: { $in: orderIds } });
        if (ts === 'completed') match.status = { $in: ['completed', 'paid'] };
        else match.status = ts; // paid → 'paid'; cancelled → 'cancelled' (terminal)
      }
    } else if (start_date || end_date) {
      const dateRange: any = {};
      if (start_date) dateRange.$gte = start_date as string;
      if (end_date) dateRange.$lte = `${end_date}T23:59:59.999Z`;

      const historyRange: any = { changed_at: {} };
      if (start_date) historyRange.changed_at.$gte = start_date as string;
      if (end_date) historyRange.changed_at.$lte = `${end_date}T23:59:59.999Z`;
      const orderIdsWithHistoryInRange = await OrderStatusHistory.find(historyRange).distinct('order_id');

      andConditions.push({
        $or: [
          { createdAt: dateRange },
          { delivery_due_date: dateRange },
          { _id: { $in: orderIdsWithHistoryInRange } },
        ],
      });
    }

    if (search) {
      const escaped = (search as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      andConditions.push({
        $or: [
          { customer_name: { $regex: escaped, $options: 'i' } },
          { order_number: { $regex: escaped, $options: 'i' } },
          { customer_mobile: { $regex: escaped, $options: 'i' } },
        ],
      });
    }

    // "Delayed only" filter — matches the frontend's isOrderDelayed() fallback to a live
    // due-date comparison, not just the is_delayed flag (which nothing in the app ever
    // actually sets via its own PATCH route, so filtering on it alone always returned empty).
    if (is_delayed === 'true') {
      andConditions.push(delayedMatchCondition(DateTime.now().toUTC().toISO()!));
    }

    if (andConditions.length) match.$and = andConditions;

    // Orders Grid View defaults to "latest interacted" (most recently updated) per the
    // PRD, distinct from Order Quickview's created-date sort.
    const sortSpec: Record<string, 1 | -1> = sort === 'updated_desc' ? { updatedAt: -1 } : { createdAt: -1 };

    const [orders, total] = await Promise.all([
      Order.find(match)
        .populate('branch_id', 'name branch_code')
        .populate('created_by', 'name role')
        .sort(sortSpec)
        .skip(skip)
        .limit(limitNum),
      Order.countDocuments(match),
    ]);

    // Order Timeline (Calendar View) needs each order's full status history to draw its
    // timeline bar. One bulk query for the page's orders, grouped by order_id (asc by time),
    // instead of an N+1 per-card lookup.
    let historyByOrder: Record<string, { status: string; changed_at: string }[]> = {};
    if (include_history === 'true') {
      const histories = await OrderStatusHistory.find({ order_id: { $in: orders.map((o) => o._id) } })
        .select('order_id status changed_at')
        .sort({ changed_at: 1 });
      historyByOrder = histories.reduce((acc, h) => {
        const key = String(h.order_id);
        (acc[key] ||= []).push({ status: h.status, changed_at: h.changed_at });
        return acc;
      }, {} as Record<string, { status: string; changed_at: string }[]>);
    }

    // Attach line items + image count + rating (PRD: Order Card shows the customer
    // rating once the order is paid and the customer has submitted one)
    const enriched = await Promise.all(
      orders.map(async (o) => {
        const [items, imageCount, rating] = await Promise.all([
          OrderService.find({ order_id: o._id }),
          OrderImage.countDocuments({ order_id: o._id }),
          OrderRating.findOne({ order_id: o._id }).select('overall_rating submitted_at'),
        ]);
        return {
          ...o.toObject(),
          items,
          image_count: imageCount,
          customer_rating: rating?.submitted_at ? rating.overall_rating : null,
          ...(include_history === 'true' ? { status_history: historyByOrder[String(o._id)] ?? [] } : {}),
        };
      })
    );

    res.json({ orders: enriched, total, page: parseInt(page as string), limit: limitNum });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/orders/:id
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null })
      // The invoice prints the branch that handled the order, and its address, beneath the
      // business name — so the branch's address fields travel with the order too.
      .populate('branch_id', 'name branch_code address_line_1 address_line_2 city state pincode')
      .populate('created_by', 'name role employee_id')
      // Needed by the invoice the Order Detail page can download once the order is paid.
      .populate('business_id', 'name address state pincode phone');

    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (!(await hasOrderBranchAccess(req.user, order))) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }

    const [items, images, history, rating] = await Promise.all([
      OrderService.find({ order_id: order._id }),
      OrderImage.find({ order_id: order._id }).sort({ sort_order: 1 }),
      OrderStatusHistory.find({ order_id: order._id })
        .populate('changed_by', 'name role')
        .sort({ changed_at: -1 }),
      OrderRating.findOne({ order_id: order._id }),
    ]);

    res.json({ ...order.toObject(), items, images, history, rating });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/orders
// PRD: Create Order Page persona is Owner/Manager only, not Worker.
router.post('/', authorizeRoles('owner', 'manager'), async (req: AuthRequest, res) => {
  const { branch_id, customer_name, customer_mobile, items, delivery_due_date, extra_charges, extra_charges_reason, notes } = req.body;
  try {
    const branch = await Branch.findOne({ _id: branch_id, business_id: req.user!.businessId, deleted_at: null });
    if (!branch) return res.status(404).json({ message: 'Branch not found' });

    const creator = await User.findById(req.user!.id).select('name employee_id');
    const employeeId = creator?.employee_id
      || creator?.name?.split(' ').map((w) => w[0]?.toUpperCase() || '').join('').slice(0, 2)
      || 'STF';

    // Build line items
    const orderItems: any[] = [];
    let total_price = 0;

    for (const item of items || []) {
      // Was previously an unscoped Service.findById — no business_id check (a cross-tenant
      // leak: any business's service_id would resolve and its details would snapshot into
      // this order) and no is_active check (a disabled service could still be added to a
      // brand-new order via a stale client cache or a direct API call, defeating the point
      // of the toggle). Only applies when service_id is actually provided — ad-hoc line
      // items with no service_id are unaffected.
      let service = null;
      if (item.service_id) {
        service = await Service.findOne({ _id: item.service_id, business_id: req.user!.businessId, deleted_at: null });
        if (!service) return res.status(400).json({ message: 'One or more selected services could not be found' });
        if (!service.is_active) return res.status(400).json({ message: `"${service.name}" is currently disabled and cannot be added to an order` });
      }
      const unit_price = item.unit_price ?? (item.pricing_mode === 'kg' ? (service?.weight_price || 0) : (service?.unit_price || 0));
      const line_total = unit_price * (item.quantity || 1);
      total_price += line_total;

      orderItems.push({
        service_id: item.service_id || null,
        service_name_snapshot: item.service_name || service?.name || '',
        article_type_snapshot: item.article_type || service?.article_type || '',
        washing_method_snapshot: item.washing_method || service?.washing_method || '',
        pricing_mode: item.pricing_mode || 'unit',
        quantity: item.quantity || 1,
        unit_price_snapshot: unit_price,
        line_total,
      });
    }

    total_price += Number(extra_charges) || 0;

    const order_number = await getNextOrderNumber(String(branch._id), branch.branch_code, employeeId);

    const order = await Order.create({
      order_number,
      business_id: req.user!.businessId,
      branch_id,
      created_by: req.user!.id,
      created_by_name_snapshot: creator?.name || '',
      customer_name,
      customer_mobile: customer_mobile || '',
      delivery_due_date: delivery_due_date || null,
      extra_charges: Number(extra_charges) || 0,
      extra_charges_reason: extra_charges_reason || '',
      total_price,
      notes: notes || '',
      status: 'created',
    });

    if (orderItems.length) {
      await OrderService.insertMany(orderItems.map((i) => ({ ...i, order_id: order._id })));
    }

    // Create rating token
    const rating_token = crypto.randomBytes(24).toString('hex');
    await OrderRating.create({ order_id: order._id, rating_token });

    // Record initial status history
    await OrderStatusHistory.create({ order_id: order._id, status: 'created', changed_by: req.user!.id });

    const whatsapp_message = buildWhatsAppMessage('order_created', {
      customer_name,
      order_number,
      business_name: '',
    });

    res.status(201).json({ order, whatsapp_message, whatsapp_phone: customer_mobile });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/orders/:id
router.put('/:id', authorizeRoles('owner', 'manager'), async (req: AuthRequest, res) => {
  const { customer_name, customer_mobile, items, delivery_due_date, extra_charges, extra_charges_reason, notes } = req.body;
  try {
    const order = await Order.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (!(await hasOrderBranchAccess(req.user, order))) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }

    if (customer_name) order.customer_name = customer_name;
    if (customer_mobile !== undefined) order.customer_mobile = customer_mobile;
    if (delivery_due_date !== undefined) order.delivery_due_date = delivery_due_date;
    if (extra_charges !== undefined) order.extra_charges = Number(extra_charges);
    if (extra_charges_reason !== undefined) order.extra_charges_reason = extra_charges_reason;
    if (notes !== undefined) order.notes = notes;
    order.updatedAt = DateTime.now().toUTC().toISO()!;

    if (items !== undefined) {
      // Validate every item *before* touching existing OrderService rows — otherwise a
      // mid-loop rejection (disabled/missing service) would leave the order with its old
      // items already deleted and nothing to replace them.
      //
      // The is_active check only applies to *newly added* services, not ones the order
      // already had — disabling a service shouldn't retroactively break editing an existing
      // order that already used it (e.g. just changing the customer name shouldn't fail
      // because a linked service was disabled sometime after this order was created).
      const existingServiceIds = new Set(
        (await OrderService.find({ order_id: order._id }).select('service_id')).map((i) => String(i.service_id))
      );

      const resolvedServices = new Map<string, any>();
      for (const item of items) {
        if (!item.service_id) continue;
        const service = await Service.findOne({ _id: item.service_id, business_id: req.user!.businessId, deleted_at: null });
        if (!service) return res.status(400).json({ message: 'One or more selected services could not be found' });
        if (!service.is_active && !existingServiceIds.has(String(item.service_id))) {
          return res.status(400).json({ message: `"${service.name}" is currently disabled and cannot be added to an order` });
        }
        resolvedServices.set(String(item.service_id), service);
      }

      await OrderService.deleteMany({ order_id: order._id });
      let total_price = order.extra_charges;

      const orderItems: any[] = [];
      for (const item of items) {
        const service = item.service_id ? resolvedServices.get(String(item.service_id)) : null;
        const unit_price = item.unit_price ?? (item.pricing_mode === 'kg' ? (service?.weight_price || 0) : (service?.unit_price || 0));
        const line_total = unit_price * (item.quantity || 1);
        total_price += line_total;

        orderItems.push({
          order_id: order._id,
          service_id: item.service_id || null,
          service_name_snapshot: item.service_name || service?.name || '',
          article_type_snapshot: item.article_type || service?.article_type || '',
          washing_method_snapshot: item.washing_method || service?.washing_method || '',
          pricing_mode: item.pricing_mode || 'unit',
          quantity: item.quantity || 1,
          unit_price_snapshot: unit_price,
          line_total,
        });
      }

      if (orderItems.length) await OrderService.insertMany(orderItems);
      order.total_price = total_price;
    } else if (extra_charges !== undefined) {
      // items weren't resent but extra_charges changed — total_price still needs to reflect
      // it. Previously this branch didn't exist, so total_price went stale whenever a caller
      // updated extra_charges without also resending items (the current OrderForm always
      // resends both together, so this was latent rather than user-visible, but the API
      // itself allowed it).
      const existingItems = await OrderService.find({ order_id: order._id }).select('line_total');
      const itemsTotal = existingItems.reduce((sum, i) => sum + i.line_total, 0);
      order.total_price = itemsTotal + order.extra_charges;
    }

    await order.save();
    res.json(order);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/orders/:id/status
router.patch('/:id/status', authorizeRoles('owner', 'manager'), async (req: AuthRequest, res) => {
  const { status } = req.body;
  const validStatuses = ['created', 'in_progress', 'completed', 'paid', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  try {
    const order = await Order.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (!(await hasOrderBranchAccess(req.user, order))) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }
    if (!isValidStatusTransition(order.status, status)) {
      return res.status(400).json({ message: `Cannot move an order from "${order.status}" to "${status}"` });
    }

    const prev_status = order.status;
    order.status = status;
    // Reaching "completed" is what the delay rule is measured against, so the moment is
    // recorded here. Going straight created → paid isn't a legal transition, so `paid`
    // always arrives with completed_at already set.
    if (status === 'completed') order.completed_at = DateTime.now().toUTC().toISO()!;
    order.updatedAt = DateTime.now().toUTC().toISO()!;
    await order.save();

    await OrderStatusHistory.create({ order_id: order._id, status, changed_by: req.user!.id });

    const whatsapp_message = buildWhatsAppMessage(`order_${status}` as WhatsAppEvent, {
      customer_name: order.customer_name,
      order_number: order.order_number,
      business_name: '',
    });

    res.json({ order, prev_status, whatsapp_message, whatsapp_phone: order.customer_mobile });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/orders/:id/delayed
router.patch('/:id/delayed', authorizeRoles('owner', 'manager'), async (req: AuthRequest, res) => {
  const { is_delayed } = req.body;
  try {
    const existing = await Order.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null }).select('branch_id');
    if (!existing) return res.status(404).json({ message: 'Order not found' });
    if (!(await hasOrderBranchAccess(req.user, existing))) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id },
      { is_delayed: Boolean(is_delayed), updatedAt: DateTime.now().toUTC().toISO() },
      { new: true }
    );
    res.json(order);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/orders/:id/notes
router.patch('/:id/notes', authorizeRoles('owner', 'manager'), async (req: AuthRequest, res) => {
  const { notes } = req.body;
  try {
    const existing = await Order.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null }).select('branch_id');
    if (!existing) return res.status(404).json({ message: 'Order not found' });
    if (!(await hasOrderBranchAccess(req.user, existing))) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id },
      { notes: notes || '', updatedAt: DateTime.now().toUTC().toISO() },
      { new: true }
    );
    res.json(order);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/orders/:id (soft delete) — the Order Card's Action Menu only shows "Delete
// Order" once an order is cancelled (OrderCardMenu.tsx's canDelete), but the API itself
// never enforced that, so a direct call could delete an order in any status. Enforced here
// to match.
router.delete('/:id', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.status !== 'cancelled') {
      return res.status(400).json({ message: 'Only cancelled orders can be deleted' });
    }

    order.deleted_at = DateTime.now().toUTC().toISO()!;
    await order.save();
    res.json({ message: 'Order deleted' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/orders/:id/history
router.get('/:id/history', async (req: AuthRequest, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null }).select('branch_id');
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (!(await hasOrderBranchAccess(req.user, order))) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }

    const history = await OrderStatusHistory.find({ order_id: req.params.id })
      .populate('changed_by', 'name role')
      .sort({ changed_at: -1 });
    res.json(history);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Images ───────────────────────────────────────────────────────────────────

// POST /api/orders/:id/images
router.post('/:id/images', authorizeRoles('owner', 'manager'), upload.array('images', 5), async (req: AuthRequest, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (!(await hasOrderBranchAccess(req.user, order))) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }

    const existingCount = await OrderImage.countDocuments({ order_id: order._id });
    const files = req.files as Express.Multer.File[];

    if (existingCount + files.length > 5) {
      return res.status(400).json({ message: `Maximum 5 images per order. Already has ${existingCount}.` });
    }

    const images = await OrderImage.insertMany(
      files.map((f, i) => ({
        order_id: order._id,
        image_url: `/uploads/orders/business_${req.user!.businessId}/${f.filename}`,
        file_size_bytes: f.size,
        sort_order: existingCount + i,
      }))
    );

    res.status(201).json(images);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/orders/:id/images/:imageId
router.delete('/:id/images/:imageId', authorizeRoles('owner', 'manager'), async (req: AuthRequest, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null }).select('branch_id');
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (!(await hasOrderBranchAccess(req.user, order))) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }

    const image = await OrderImage.findOne({ _id: req.params.imageId, order_id: req.params.id });
    if (!image) return res.status(404).json({ message: 'Image not found' });

    const filename = path.basename(image.image_url);
    const filePath = path.join(uploadsDir, 'orders', `business_${req.user!.businessId}`, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await OrderImage.deleteOne({ _id: image._id });
    res.json({ message: 'Image deleted' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/orders/:id/invoice
router.get('/:id/invoice', async (req: AuthRequest, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, business_id: req.user!.businessId, deleted_at: null })
      .populate('branch_id', 'name branch_code address_line_1 address_line_2 city state pincode')
      .populate('business_id', 'name phone address')
      .populate('created_by', 'name');

    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (!(await hasOrderBranchAccess(req.user, order))) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }

    const items = await OrderService.find({ order_id: order._id });
    res.json({ order, items });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
