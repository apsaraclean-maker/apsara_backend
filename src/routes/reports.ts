import { Router } from 'express';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { Order, OrderService, OrderStatusHistory } from '../models.js';
import { sessionVerification, authorizeRoles, getAccessibleBranchIds, type AuthRequest } from '../middleware/auth.js';
import { isOrderDelayed } from '../utils/orderDelay.js';
import { nowInBusinessTz, parseDateInBusinessTz } from '../utils/timezone.js';

const router = Router();
router.use(sessionVerification);

const DURATION_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30, quarterly: 90, yearly: 365 };

// Hard ceiling on rows returned in one response. A "yearly" report previously ran an
// unbounded Order.find and then pulled every one of those orders' line items and paid-status
// history in behind it — memory, serialisation cost and response size all scaled with however
// many orders the business had taken that year, with nothing to stop it. The summary totals
// are still computed across the *whole* period (they're aggregated in the database, not
// derived from these rows), so the headline numbers stay correct even when the row list is
// clipped; `truncated` tells the caller it happened.
const MAX_REPORT_ROWS = 5000;

// GET /api/reports/sales?duration=daily|weekly|monthly|quarterly|yearly|custom&start_date=&end_date=&branch_id=
router.get('/sales', authorizeRoles('owner', 'manager'), async (req: AuthRequest, res) => {
  try {
    const { duration, start_date, end_date, branch_id } = req.query;
    const now = nowInBusinessTz();

    let startDt: DateTime;
    let endDt: DateTime = now.endOf('day');

    if (duration === 'custom') {
      if (!start_date || !end_date) {
        return res.status(400).json({ message: 'start_date and end_date required for custom duration' });
      }
      startDt = parseDateInBusinessTz(start_date as string).startOf('day');
      endDt = parseDateInBusinessTz(end_date as string).endOf('day');
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

    // startDt/endDt are IST-zoned so the calendar boundary itself is correct; convert to
    // UTC here since createdAt is stored as UTC ISO strings and a "+05:30"-offset string
    // wouldn't compare correctly against them.
    const match: any = {
      business_id: new mongoose.Types.ObjectId(req.user!.businessId!),
      deleted_at: null,
      createdAt: { $gte: startDt.toJSDate(), $lte: endDt.toJSDate() },
    };
    if (branch_id) {
      match.branch_id = new mongoose.Types.ObjectId(branch_id as string);
    } else if (accessibleBranchIds !== null) {
      // Manager with no branch_id filter: restricted to all branches they're assigned to.
      match.branch_id = { $in: accessibleBranchIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }

    // Totals are aggregated in the database over the entire period rather than summed from
    // the rows below, so clipping the row list can't skew the headline figures.
    const [orders, summaryAgg] = await Promise.all([
      Order.find(match)
        .populate('branch_id', 'name branch_code')
        .populate('created_by', 'name')
        .sort({ createdAt: -1 })
        .limit(MAX_REPORT_ROWS)
        .lean(),
      Order.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total_orders: { $sum: 1 },
            total_revenue: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$total_price', 0] } },
          },
        },
      ]),
    ]);

    const orderIds = orders.map((o) => o._id);

    const [items, paidHistory] = await Promise.all([
      OrderService.find({ order_id: { $in: orderIds } }).lean(),
      // "Order Marked Paid" needs the date it *entered* paid status, not just current
      // status/updatedAt — an order could theoretically be reopened after being paid.
      OrderStatusHistory.find({ order_id: { $in: orderIds }, status: 'paid' }).sort({ changed_at: -1 }).lean(),
    ]);

    const itemsByOrder = new Map<string, typeof items>();
    for (const item of items) {
      const key = String(item.order_id);
      if (!itemsByOrder.has(key)) itemsByOrder.set(key, []);
      itemsByOrder.get(key)!.push(item);
    }

    const paidDateByOrder = new Map<string, Date>();
    for (const h of paidHistory) {
      const key = String(h.order_id);
      if (!paidDateByOrder.has(key)) paidDateByOrder.set(key, h.changed_at as Date); // sorted desc — first hit is latest
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
        created_by: (o.created_by as any)?.name || o.created_by_name_snapshot || '',
        order: itemsList,
        note: o.notes || '',
        extra_price: o.extra_charges || 0,
        total_price: o.total_price,
      };
    });

    const summary = summaryAgg[0] ?? { total_revenue: 0, total_orders: 0 };

    res.json({
      period: { start: startDt.toISODate(), end: endDt.toISODate() },
      summary: { total_revenue: summary.total_revenue, total_orders: summary.total_orders },
      // True when the period holds more orders than one response will carry. The summary
      // still covers the full period; only `rows` is clipped.
      truncated: summary.total_orders > rows.length,
      rows,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
