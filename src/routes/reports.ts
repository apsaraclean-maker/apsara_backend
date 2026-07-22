import { Router } from 'express';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { Order, OrderService, OrderStatusHistory } from '../models.js';
import { sessionVerification, authorizeRoles, getAccessibleBranchIds, type AuthRequest } from '../middleware/auth.js';
import { isOrderDelayed } from '../utils/orderDelay.js';

const router = Router();
router.use(sessionVerification);

const DURATION_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30, quarterly: 90, yearly: 365 };

// GET /api/reports/sales?duration=daily|weekly|monthly|quarterly|yearly|custom&start_date=&end_date=&branch_id=
router.get('/sales', authorizeRoles('owner', 'manager'), async (req: AuthRequest, res) => {
  try {
    const { duration, start_date, end_date, branch_id } = req.query;
    const now = DateTime.now().toUTC();

    let startDt: DateTime;
    let endDt: DateTime = now.endOf('day');

    if (duration === 'custom') {
      if (!start_date || !end_date) {
        return res.status(400).json({ message: 'start_date and end_date required for custom duration' });
      }
      startDt = DateTime.fromISO(start_date as string).startOf('day');
      endDt = DateTime.fromISO(end_date as string).endOf('day');
    } else {
      // Rolling trailing window ending now, matching /dashboard/stats' convention
      // rather than calendar-aligned periods.
      const windowDays = DURATION_DAYS[duration as string] || DURATION_DAYS.monthly;
      startDt = now.minus({ days: windowDays }).startOf('day');
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
      // Manager with no branch_id filter: restricted to all branches they're assigned to.
      match.branch_id = { $in: accessibleBranchIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }

    const orders = await Order.find(match)
      .populate('branch_id', 'name branch_code')
      .populate('created_by', 'name')
      .sort({ createdAt: -1 });

    const orderIds = orders.map((o) => o._id);

    const [items, paidHistory] = await Promise.all([
      OrderService.find({ order_id: { $in: orderIds } }),
      // "Order Marked Paid" needs the date it *entered* paid status, not just current
      // status/updatedAt — an order could theoretically be reopened after being paid.
      OrderStatusHistory.find({ order_id: { $in: orderIds }, status: 'paid' }).sort({ changed_at: -1 }),
    ]);

    const itemsByOrder = new Map<string, typeof items>();
    for (const item of items) {
      const key = String(item.order_id);
      if (!itemsByOrder.has(key)) itemsByOrder.set(key, []);
      itemsByOrder.get(key)!.push(item);
    }

    const paidDateByOrder = new Map<string, string>();
    for (const h of paidHistory) {
      const key = String(h.order_id);
      if (!paidDateByOrder.has(key)) paidDateByOrder.set(key, h.changed_at); // sorted desc — first hit is latest
    }

    const rows = orders.map((o, index) => {
      const orderItems = itemsByOrder.get(String(o._id)) || [];
      const itemsList = orderItems
        .map((i) => `${i.service_name_snapshot} (${i.quantity} ${i.pricing_mode === 'kg' ? 'kg' : 'pc'})`)
        .join(', ');

      return {
        sno: index + 1,
        order_id: o.order_number,
        order_created: o.createdAt,
        due_date: o.delivery_due_date || '',
        order_marked_paid: paidDateByOrder.get(String(o._id)) || '',
        order_status: o.status,
        delayed: isOrderDelayed(o) ? 'Delayed' : '',
        customer_contact: o.customer_mobile,
        created_by: (o.created_by as any)?.name || '',
        order: itemsList,
        note: o.notes || '',
        extra_price: o.extra_charges || 0,
        total_price: o.total_price,
      };
    });

    const total_revenue = orders.filter((o) => o.status === 'paid').reduce((s, o) => s + o.total_price, 0);

    res.json({
      period: { start: startDt.toISODate(), end: endDt.toISODate() },
      summary: { total_revenue, total_orders: orders.length },
      rows,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
