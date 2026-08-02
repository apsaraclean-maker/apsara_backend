import { Router } from 'express';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { Order, OrderRating, OrderStatusHistory, Branch, UserBranch } from '../models.js';
import { sessionVerification, authorizeRoles, getAccessibleBranchIds, type AuthRequest } from '../middleware/auth.js';
import { delayedMatchCondition } from '../utils/orderDelay.js';
import { nowInBusinessTz, parseDateInBusinessTz, toBusinessDateString } from '../utils/timezone.js';

const router = Router();
router.use(sessionVerification);

// Builds the business/deleted_at/branch_id match, clipping or rejecting branch_id against
// the caller's accessible branches (owners are unrestricted; managers/workers are limited
// to their UserBranch assignments — see getAccessibleBranchIds).
async function branchFilter(user: AuthRequest['user'], branchId?: string): Promise<{ match: any; error?: string }> {
  const match: any = { business_id: new mongoose.Types.ObjectId(user!.businessId!), deleted_at: null };
  const accessibleBranchIds = await getAccessibleBranchIds(user!);

  if (accessibleBranchIds === null) {
    if (branchId) match.branch_id = new mongoose.Types.ObjectId(branchId);
  } else if (branchId) {
    if (!accessibleBranchIds.includes(branchId)) {
      return { match, error: 'Access to this branch is not permitted' };
    }
    match.branch_id = new mongoose.Types.ObjectId(branchId);
  } else {
    match.branch_id = { $in: accessibleBranchIds.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  return { match };
}

// GET /api/dashboard/quickview?branch_id=
router.get('/quickview', async (req: AuthRequest, res) => {
  try {
    const { branch_id } = req.query;
    const todayIST = nowInBusinessTz();
    const todayStartUTC = todayIST.startOf('day').toUTC().toISO()!;
    const todayEndUTC = todayIST.endOf('day').toUTC().toISO()!;
    const { match, error } = await branchFilter(req.user, branch_id as string);
    if (error) return res.status(403).json({ message: error });
    const todayMatch = {
      ...match,
      createdAt: { $gte: todayStartUTC, $lte: todayEndUTC },
    };

    const [
      todayOrders,
      todayRevenue,
      pending,
      delayed,
      cancelled,
      recentOrders,
    ] = await Promise.all([
      Order.countDocuments(todayMatch),
      Order.aggregate([{ $match: { ...todayMatch, status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total_price' } } }]),
      Order.countDocuments({ ...match, status: { $in: ['created', 'in_progress'] } }),
      Order.countDocuments({ ...match, ...delayedMatchCondition(DateTime.now().toUTC().toISO()!) }),
      Order.countDocuments({ ...match, status: 'cancelled', createdAt: { $gte: todayStartUTC } }),
      Order.find(match)
        .populate('branch_id', 'name branch_code')
        .sort({ createdAt: -1 })
        .limit(10),
    ]);

    res.json({
      today_orders: todayOrders,
      today_revenue: todayRevenue[0]?.total || 0,
      pending,
      delayed,
      today_cancelled: cancelled,
      recent_orders: recentOrders,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/dashboard/timeline?branch_id=&start_date=&end_date=&days=
// Returns a date × status matrix for the Order Timeline tab. Columns are
// created/order_due/completed/paid/cancelled (per the PRD's Order Card UI calculation
// logic), computed point-in-time-correct:
//   - created:   orders created that day, excluding ones now cancelled
//   - order_due: orders whose delivery_due_date falls that day, excluding cancelled
//   - completed: orders with a 'completed' history entry that day, but only if the order
//                hasn't since reverted below completed (current status is completed/paid)
//   - paid:      orders with a 'paid' history entry that day, only if still currently paid
//   - cancelled: orders cancelled that day, only if still cancelled — cancelling is
//                reversible (isValidStatusTransition permits cancelled → created), so a
//                reopened order must drop out of this row the way it drops back into
//                'created'. Otherwise it is counted in two places at once.
//
// Every row therefore reflects the order's current state. Status history is append-only and
// an order can reach the same status more than once (completed → in_progress → completed),
// so entries are reduced to the latest one per order and status before counting; without
// that, one order stepped back and finished again is counted twice.
router.get('/timeline', async (req: AuthRequest, res) => {
  try {
    const { branch_id, start_date, end_date, days: daysParam } = req.query;

    let startDt: DateTime;
    let endDt: DateTime;
    if (start_date || end_date) {
      startDt = start_date
        ? parseDateInBusinessTz(start_date as string).startOf('day')
        : nowInBusinessTz().minus({ days: 6 }).startOf('day');
      endDt = end_date
        ? parseDateInBusinessTz(end_date as string).endOf('day')
        : nowInBusinessTz().endOf('day');
    } else {
      // Default view: today centered in the window (per PRD's "current date sits in the
      // middle by default"), spanning `days` total (9 to match the PRD's desktop example).
      const windowSize = daysParam ? Math.max(1, parseInt(daysParam as string)) : 9;
      const before = Math.floor((windowSize - 1) / 2);
      startDt = nowInBusinessTz().minus({ days: before }).startOf('day');
      endDt = startDt.plus({ days: windowSize - 1 }).endOf('day');
    }

    const { match, error } = await branchFilter(req.user, branch_id as string);
    if (error) return res.status(403).json({ message: error });

    const statuses = ['created', 'order_due', 'completed', 'paid', 'cancelled'];
    const matrix: Record<string, Record<string, number>> = {};
    const dates: string[] = [];
    let cursor = startDt;
    while (cursor <= endDt) {
      const d = cursor.toFormat('yyyy-MM-dd');
      dates.push(d);
      matrix[d] = Object.fromEntries(statuses.map((s) => [s, 0]));
      cursor = cursor.plus({ days: 1 });
    }

    // startDt/endDt are IST-zoned (so the calendar-day boundary itself is correct in IST),
    // but the query needs UTC ISO strings to compare correctly against the UTC-stored
    // createdAt/delivery_due_date/changed_at fields — a "+05:30"-offset ISO string doesn't
    // sort correctly against 'Z'-suffixed UTC strings under plain lexicographic comparison.
    const startISO = startDt.toUTC().toISO()!;
    const endISO = endDt.toUTC().toISO()!;

    const [ordersInRange, historyEntries] = await Promise.all([
      Order.find({
        ...match,
        $or: [
          { createdAt: { $gte: startISO, $lte: endISO } },
          { delivery_due_date: { $gte: startISO, $lte: endISO } },
        ],
      }).select('createdAt delivery_due_date status'),
      OrderStatusHistory.aggregate([
        { $match: { status: { $in: ['completed', 'paid', 'cancelled'] }, changed_at: { $gte: startISO, $lte: endISO } } },
        { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
        { $unwind: '$order' },
        {
          $match: {
            'order.business_id': match.business_id,
            'order.deleted_at': null,
            ...(match.branch_id !== undefined ? { 'order.branch_id': match.branch_id } : {}),
          },
        },
        // Latest visit per order and status, so a repeated transition counts once.
        { $sort: { changed_at: -1 } },
        {
          $group: {
            _id: { order_id: '$order_id', status: '$status' },
            status: { $first: '$status' },
            changed_at: { $first: '$changed_at' },
            current_status: { $first: '$order.status' },
          },
        },
      ]),
    ]);

    for (const order of ordersInRange) {
      if (order.status === 'cancelled') continue;
      const createdDay = toBusinessDateString(order.createdAt);
      if (matrix[createdDay]) matrix[createdDay].created++;
      if (order.delivery_due_date) {
        const dueDay = toBusinessDateString(order.delivery_due_date);
        if (matrix[dueDay]) matrix[dueDay].order_due++;
      }
    }

    for (const h of historyEntries) {
      const d = toBusinessDateString(h.changed_at);
      if (!matrix[d]) continue;
      if (h.status === 'completed' && ['completed', 'paid'].includes(h.current_status)) matrix[d].completed++;
      else if (h.status === 'paid' && h.current_status === 'paid') matrix[d].paid++;
      else if (h.status === 'cancelled' && h.current_status === 'cancelled') matrix[d].cancelled++;
    }

    res.json({ dates, statuses, matrix, today: nowInBusinessTz().toFormat('yyyy-MM-dd') });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

const TIMEFRAME_DAYS: Record<string, number> = { weekly: 7, monthly: 30, quarterly: 90, yearly: 365 };

// GET /api/dashboard/stats?branch_id=&timeframe=weekly|monthly|quarterly|yearly
// Rolling trailing window ending now (per the PRD's "for the selected timeframe leading
// till the current date" wording), not a calendar-aligned month. Owner/manager only —
// the PRD says Business Stats is hidden entirely for Workers.
router.get('/stats', authorizeRoles('owner', 'manager'), async (req: AuthRequest, res) => {
  try {
    const { branch_id, timeframe } = req.query;

    const windowDays = TIMEFRAME_DAYS[timeframe as string] || TIMEFRAME_DAYS.monthly;
    const end = DateTime.now().toUTC().toISO()!;
    const start = DateTime.now().toUTC().minus({ days: windowDays }).toISO()!;

    const { match: baseMatch, error } = await branchFilter(req.user, branch_id as string);
    if (error) return res.status(403).json({ message: error });
    const match = { ...baseMatch, createdAt: { $gte: start, $lte: end } };

    const [
      revenueAgg,
      paidOrders,
      cancelledOrders,
      // Customers Served: unique customers with a *paid* order in the window (PRD-literal).
      servedCustomers,
      // New Customers needs each window customer's full order history to know if the
      // window order was their first ever — not just whether they appear in the window.
      windowCustomers,
      customersBeforeWindow,
      ratingsAgg,
    ] = await Promise.all([
      Order.aggregate([
        { $match: { ...match, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$total_price' } } },
      ]),
      Order.countDocuments({ ...match, status: 'paid' }),
      Order.countDocuments({ ...match, status: 'cancelled' }),
      Order.distinct('customer_mobile', { ...match, status: 'paid' }),
      Order.distinct('customer_mobile', match),
      Order.distinct('customer_mobile', { ...baseMatch, createdAt: { $lt: start } }),
      OrderRating.aggregate([
        {
          $lookup: {
            from: 'orders',
            localField: 'order_id',
            foreignField: '_id',
            as: 'order',
          },
        },
        { $unwind: '$order' },
        {
          $match: {
            'order.business_id': new mongoose.Types.ObjectId(req.user!.businessId!),
            submitted_at: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: null,
            avg_overall: { $avg: '$overall_rating' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const beforeSet = new Set(customersBeforeWindow.filter(Boolean));
    const newCustomers = windowCustomers.filter(Boolean).filter((c) => !beforeSet.has(c));

    res.json({
      total_revenue: revenueAgg[0]?.total || 0,
      customer_rating: ratingsAgg[0]?.avg_overall ? Number(ratingsAgg[0].avg_overall.toFixed(1)) : null,
      customers_served: servedCustomers.filter(Boolean).length,
      new_customers: newCustomers.length,
      completed_orders: paidOrders,
      cancelled_orders: cancelledOrders,
      timeframe: timeframe && TIMEFRAME_DAYS[timeframe as string] ? timeframe : 'monthly',
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/dashboard/onboarding
router.get('/onboarding', async (req: AuthRequest, res) => {
  try {
    const { Service } = await import('../models.js');
    const [branchCount, serviceCount, staffCount] = await Promise.all([
      Branch.countDocuments({ business_id: req.user!.businessId, deleted_at: null }),
      Service.countDocuments({ business_id: req.user!.businessId, deleted_at: null }),
      // Worker + Manager count
      (await import('../models.js')).User.countDocuments({
        business_id: req.user!.businessId,
        role: { $in: ['manager', 'worker'] },
        deleted_at: null,
      }),
    ]);
    res.json({ has_branch: branchCount > 0, has_services: serviceCount > 0, has_staff: staffCount > 0 });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
