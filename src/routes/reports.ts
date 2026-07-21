import { Router } from 'express';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { Order, OrderService, Branch } from '../models.js';
import { sessionVerification, authorizeRoles, getAccessibleBranchIds, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(sessionVerification);

// GET /api/reports/sales?duration=today|weekly|monthly|custom&start_date=&end_date=&branch_id=
router.get('/sales', authorizeRoles('owner', 'manager'), async (req: AuthRequest, res) => {
  try {
    const { duration, start_date, end_date, branch_id } = req.query;
    const now = DateTime.now().toUTC();

    let startDt: DateTime;
    let endDt: DateTime = now.endOf('day');

    switch (duration) {
      case 'today':
        startDt = now.startOf('day');
        break;
      case 'weekly':
        startDt = now.minus({ days: 6 }).startOf('day');
        break;
      case 'monthly':
        startDt = now.startOf('month');
        break;
      case 'custom':
        if (!start_date || !end_date) {
          return res.status(400).json({ message: 'start_date and end_date required for custom duration' });
        }
        startDt = DateTime.fromISO(start_date as string).startOf('day');
        endDt = DateTime.fromISO(end_date as string).endOf('day');
        break;
      default:
        startDt = now.startOf('month');
    }

    const accessibleBranchIds = await getAccessibleBranchIds(req.user!);
    if (accessibleBranchIds !== null && branch_id && !accessibleBranchIds.includes(branch_id as string)) {
      return res.status(403).json({ message: 'Access to this branch is not permitted' });
    }

    const match: any = {
      business_id: new mongoose.Types.ObjectId(req.user!.businessId!),
      deleted_at: null,
      createdAt: { $gte: startDt.toISO()!, $lte: endDt.toISO()! },
    };
    if (branch_id) {
      match.branch_id = new mongoose.Types.ObjectId(branch_id as string);
    } else if (accessibleBranchIds !== null) {
      match.branch_id = { $in: accessibleBranchIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }

    const orders = await Order.find(match)
      .populate('branch_id', 'name branch_code')
      .populate('created_by', 'name')
      .sort({ createdAt: -1 });

    // Build report rows
    const rows = await Promise.all(
      orders.map(async (o) => {
        const items = await OrderService.find({ order_id: o._id });
        return {
          order_number: o.order_number,
          customer_name: o.customer_name,
          customer_mobile: o.customer_mobile,
          branch: (o.branch_id as any)?.name || '',
          status: o.status,
          items: items.map((i) => `${i.service_name_snapshot} x${i.quantity}`).join(', '),
          total_price: o.total_price,
          extra_charges: o.extra_charges,
          created_date: DateTime.fromISO(o.createdAt).toFormat('dd/MM/yyyy HH:mm'),
          due_date: o.delivery_due_date || '',
          created_by: (o.created_by as any)?.name || '',
        };
      })
    );

    // Summary stats
    const total_revenue = orders.filter((o) => o.status === 'paid').reduce((s, o) => s + o.total_price, 0);
    const total_orders = orders.length;
    const completed = orders.filter((o) => o.status === 'completed').length;
    const cancelled = orders.filter((o) => o.status === 'cancelled').length;

    res.json({
      period: { start: startDt.toISODate(), end: endDt.toISODate() },
      summary: { total_revenue, total_orders, completed, cancelled },
      rows,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
