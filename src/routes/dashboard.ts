import { Router } from 'express';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { Order, OrderRating, Branch, UserBranch } from '../models.js';
import { sessionVerification, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(sessionVerification);

function branchFilter(businessId: string, branchId?: string) {
  const match: any = { business_id: new mongoose.Types.ObjectId(businessId), deleted_at: null };
  if (branchId) match.branch_id = new mongoose.Types.ObjectId(branchId);
  return match;
}

// GET /api/dashboard/quickview?branch_id=
router.get('/quickview', async (req: AuthRequest, res) => {
  try {
    const { branch_id } = req.query;
    const today = DateTime.now().toUTC().toFormat("yyyy-MM-dd");
    const match = branchFilter(req.user!.businessId!, branch_id as string);
    const todayMatch = {
      ...match,
      createdAt: { $gte: today, $lte: `${today}T23:59:59.999Z` },
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
      Order.countDocuments({ ...match, is_delayed: true, status: { $nin: ['paid', 'cancelled'] } }),
      Order.countDocuments({ ...match, status: 'cancelled', createdAt: { $gte: today } }),
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

// GET /api/dashboard/timeline?branch_id=&start_date=&end_date=
// Returns a date × status matrix for the Order Timeline tab
router.get('/timeline', async (req: AuthRequest, res) => {
  try {
    const { branch_id, start_date, end_date } = req.query;

    const startDt = start_date
      ? DateTime.fromISO(start_date as string).toUTC()
      : DateTime.now().toUTC().minus({ days: 6 }).startOf('day');
    const endDt = end_date
      ? DateTime.fromISO(end_date as string).toUTC().endOf('day')
      : DateTime.now().toUTC().endOf('day');

    const match: any = {
      business_id: new mongoose.Types.ObjectId(req.user!.businessId!),
      deleted_at: null,
      createdAt: { $gte: startDt.toISO()!, $lte: endDt.toISO()! },
    };
    if (branch_id) match.branch_id = new mongoose.Types.ObjectId(branch_id as string);

    const orders = await Order.find(match).select('status createdAt is_delayed order_number customer_name');

    // Build matrix: { [date]: { [status]: count } }
    const matrix: Record<string, Record<string, number>> = {};
    const statuses = ['created', 'in_progress', 'completed', 'paid', 'cancelled'];

    // Generate date range
    const days: string[] = [];
    let cursor = startDt;
    while (cursor <= endDt) {
      const d = cursor.toFormat('yyyy-MM-dd');
      days.push(d);
      matrix[d] = Object.fromEntries(statuses.map((s) => [s, 0]));
      cursor = cursor.plus({ days: 1 });
    }

    for (const order of orders) {
      const d = DateTime.fromISO(order.createdAt).toFormat('yyyy-MM-dd');
      if (matrix[d] && order.status) {
        matrix[d][order.status] = (matrix[d][order.status] || 0) + 1;
      }
    }

    res.json({ dates: days, statuses, matrix });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/dashboard/stats?branch_id=&month=YYYY-MM
router.get('/stats', async (req: AuthRequest, res) => {
  try {
    const { branch_id, month } = req.query;

    const dt = month ? DateTime.fromFormat(month as string, 'yyyy-MM') : DateTime.now().toUTC();
    const start = dt.startOf('month').toISO()!;
    const end = dt.endOf('month').toISO()!;

    const match = {
      ...branchFilter(req.user!.businessId!, branch_id as string),
      createdAt: { $gte: start, $lte: end },
    };

    const [
      revenueAgg,
      completedOrders,
      cancelledOrders,
      newCustomers,
      allCustomers,
      ratingsAgg,
    ] = await Promise.all([
      Order.aggregate([
        { $match: { ...match, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$total_price' } } },
      ]),
      Order.countDocuments({ ...match, status: 'completed' }),
      Order.countDocuments({ ...match, status: 'cancelled' }),
      // New customers = unique customer_mobile first seen this month
      Order.distinct('customer_mobile', match),
      Order.distinct('customer_mobile', branchFilter(req.user!.businessId!, branch_id as string)),
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

    res.json({
      total_revenue: revenueAgg[0]?.total || 0,
      customer_rating: ratingsAgg[0]?.avg_overall ? Number(ratingsAgg[0].avg_overall.toFixed(1)) : null,
      customers_served: allCustomers.filter(Boolean).length,
      new_customers: newCustomers.filter(Boolean).length,
      completed_orders: completedOrders,
      cancelled_orders: cancelledOrders,
      month: dt.toFormat('yyyy-MM'),
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
