import { Router } from 'express';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { Order, OrderRating, OrderStatusHistory, Branch } from '../models.js';
import { sessionVerification, authorizeRoles, getAccessibleBranchIds } from '../middleware/auth.js';
import { delayedMatchCondition } from '../utils/orderDelay.js';
import { nowInBusinessTz, parseDateInBusinessTz, BUSINESS_TZ_DATE_STRING } from '../utils/timezone.js';
const router = Router();
router.use(sessionVerification);
// Builds the business/deleted_at/branch_id match, clipping or rejecting branch_id against
// the caller's accessible branches (owners are unrestricted; managers/workers are limited
// to their UserBranch assignments — see getAccessibleBranchIds).
async function branchFilter(user, branchId) {
    const match = { business_id: new mongoose.Types.ObjectId(user.businessId), deleted_at: null };
    const accessibleBranchIds = await getAccessibleBranchIds(user);
    if (accessibleBranchIds === null) {
        if (branchId)
            match.branch_id = new mongoose.Types.ObjectId(branchId);
    }
    else if (branchId) {
        if (!accessibleBranchIds.includes(branchId)) {
            return { match, error: 'Access to this branch is not permitted' };
        }
        match.branch_id = new mongoose.Types.ObjectId(branchId);
    }
    else {
        match.branch_id = { $in: accessibleBranchIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }
    return { match };
}
// GET /api/dashboard/quickview?branch_id=
router.get('/quickview', async (req, res) => {
    try {
        const { branch_id } = req.query;
        const todayIST = nowInBusinessTz();
        const todayStartUTC = todayIST.startOf('day').toJSDate();
        const todayEndUTC = todayIST.endOf('day').toJSDate();
        const { match, error } = await branchFilter(req.user, branch_id);
        if (error)
            return res.status(403).json({ message: error });
        const todayRange = { $gte: todayStartUTC, $lte: todayEndUTC };
        // Six separate trips to the same collection collapsed into two. $facet evaluates the
        // shared `match` once and forks it, so the five tiles are one pass over one index rather
        // than five independent traversals — and the delayed count is now a plain equality on the
        // stored is_delayed flag instead of the unindexable $expr predicate it used to be.
        //
        // The recent-orders list stays separate: it needs a branch $lookup that the counting
        // branches don't, and folding it in would drag those fields through every facet.
        const [tiles, recentOrders] = await Promise.all([
            Order.aggregate([
                { $match: match },
                {
                    $facet: {
                        today_orders: [{ $match: { createdAt: todayRange } }, { $count: 'count' }],
                        today_revenue: [
                            { $match: { createdAt: todayRange, status: 'paid' } },
                            { $group: { _id: null, total: { $sum: '$total_price' } } },
                        ],
                        pending: [{ $match: { status: { $in: ['created', 'in_progress'] } } }, { $count: 'count' }],
                        delayed: [{ $match: delayedMatchCondition() }, { $count: 'count' }],
                        today_cancelled: [
                            { $match: { status: 'cancelled', createdAt: { $gte: todayStartUTC } } },
                            { $count: 'count' },
                        ],
                    },
                },
            ]),
            Order.find(match)
                .populate('branch_id', 'name branch_code')
                .sort({ createdAt: -1 })
                .limit(10)
                .lean(),
        ]);
        const f = tiles[0] ?? {};
        res.json({
            today_orders: f.today_orders?.[0]?.count || 0,
            today_revenue: f.today_revenue?.[0]?.total || 0,
            pending: f.pending?.[0]?.count || 0,
            delayed: f.delayed?.[0]?.count || 0,
            today_cancelled: f.today_cancelled?.[0]?.count || 0,
            recent_orders: recentOrders,
        });
    }
    catch (err) {
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
router.get('/timeline', async (req, res) => {
    try {
        const { branch_id, start_date, end_date, days: daysParam } = req.query;
        let startDt;
        let endDt;
        if (start_date || end_date) {
            startDt = start_date
                ? parseDateInBusinessTz(start_date).startOf('day')
                : nowInBusinessTz().minus({ days: 6 }).startOf('day');
            endDt = end_date
                ? parseDateInBusinessTz(end_date).endOf('day')
                : nowInBusinessTz().endOf('day');
        }
        else {
            // Default view: today centered in the window (per PRD's "current date sits in the
            // middle by default"), spanning `days` total (9 to match the PRD's desktop example).
            const windowSize = daysParam ? Math.max(1, parseInt(daysParam)) : 9;
            const before = Math.floor((windowSize - 1) / 2);
            startDt = nowInBusinessTz().minus({ days: before }).startOf('day');
            endDt = startDt.plus({ days: windowSize - 1 }).endOf('day');
        }
        const { match, error } = await branchFilter(req.user, branch_id);
        if (error)
            return res.status(403).json({ message: error });
        const statuses = ['created', 'order_due', 'completed', 'paid', 'cancelled'];
        const matrix = {};
        const dates = [];
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
        const startUTC = startDt.toJSDate();
        const endUTC = endDt.toJSDate();
        const range = { $gte: startUTC, $lte: endUTC };
        const [orderBuckets, historyEntries] = await Promise.all([
            // The created/order_due columns are counted in the pipeline via $dateToString with an
            // explicit IST timezone, rather than streaming every matching order back into Node to
            // bucket it there. Only two small rows per calendar day cross the wire now.
            Order.aggregate([
                { $match: { ...match, status: { $ne: 'cancelled' }, $or: [{ createdAt: range }, { delivery_due_date: range }] } },
                {
                    $project: {
                        created_day: {
                            $cond: [
                                { $and: [{ $gte: ['$createdAt', startUTC] }, { $lte: ['$createdAt', endUTC] }] },
                                BUSINESS_TZ_DATE_STRING('$createdAt'),
                                null,
                            ],
                        },
                        due_day: {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: ['$delivery_due_date', null] },
                                        { $gte: ['$delivery_due_date', startUTC] },
                                        { $lte: ['$delivery_due_date', endUTC] },
                                    ],
                                },
                                BUSINESS_TZ_DATE_STRING('$delivery_due_date'),
                                null,
                            ],
                        },
                    },
                },
                {
                    $facet: {
                        created: [{ $match: { created_day: { $ne: null } } }, { $group: { _id: '$created_day', n: { $sum: 1 } } }],
                        order_due: [{ $match: { due_day: { $ne: null } } }, { $group: { _id: '$due_day', n: { $sum: 1 } } }],
                    },
                },
            ]),
            OrderStatusHistory.aggregate([
                // Rides the new {status, changed_at} index — this stage previously had nothing to
                // narrow on and scanned the whole collection before the join could even start.
                { $match: { status: { $in: ['completed', 'paid', 'cancelled'] }, changed_at: range } },
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
                // Drop the rows that don't survive the point-in-time rules before counting, then
                // bucket by IST day in the pipeline — the counts, not the entries, come back.
                {
                    $match: {
                        $expr: {
                            $or: [
                                { $and: [{ $eq: ['$status', 'completed'] }, { $in: ['$current_status', ['completed', 'paid']] }] },
                                { $and: [{ $eq: ['$status', 'paid'] }, { $eq: ['$current_status', 'paid'] }] },
                                { $and: [{ $eq: ['$status', 'cancelled'] }, { $eq: ['$current_status', 'cancelled'] }] },
                            ],
                        },
                    },
                },
                { $group: { _id: { day: BUSINESS_TZ_DATE_STRING('$changed_at'), status: '$status' }, n: { $sum: 1 } } },
            ]),
        ]);
        for (const row of orderBuckets[0]?.created ?? []) {
            if (matrix[row._id])
                matrix[row._id].created += row.n;
        }
        for (const row of orderBuckets[0]?.order_due ?? []) {
            if (matrix[row._id])
                matrix[row._id].order_due += row.n;
        }
        for (const row of historyEntries) {
            const cell = matrix[row._id.day];
            if (cell)
                cell[row._id.status] += row.n;
        }
        res.json({ dates, statuses, matrix, today: nowInBusinessTz().toFormat('yyyy-MM-dd') });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
const TIMEFRAME_DAYS = { weekly: 7, monthly: 30, quarterly: 90, yearly: 365 };
// GET /api/dashboard/stats?branch_id=&timeframe=weekly|monthly|quarterly|yearly
// Rolling trailing window ending now (per the PRD's "for the selected timeframe leading
// till the current date" wording), not a calendar-aligned month. Owner/manager only —
// the PRD says Business Stats is hidden entirely for Workers.
router.get('/stats', authorizeRoles('owner', 'manager'), async (req, res) => {
    try {
        const { branch_id, timeframe } = req.query;
        const windowDays = TIMEFRAME_DAYS[timeframe] || TIMEFRAME_DAYS.monthly;
        const end = DateTime.now().toUTC().toJSDate();
        const start = DateTime.now().toUTC().minus({ days: windowDays }).toJSDate();
        const { match: baseMatch, error } = await branchFilter(req.user, branch_id);
        if (error)
            return res.status(403).json({ message: error });
        // Six queries became two.
        //
        // The expensive one was "New Customers", which used to read back every distinct
        // customer_mobile the business had *ever* recorded before the window — a set that grows
        // for the life of the account and was re-read on every dashboard load, only to be turned
        // into an in-memory Set and diffed. Grouping by customer instead, with $min over their
        // first order date, answers the same question in one indexed pass and returns a handful
        // of numbers rather than a list of every customer.
        const [stats, ratingsAgg] = await Promise.all([
            Order.aggregate([
                { $match: baseMatch },
                {
                    $facet: {
                        window_totals: [
                            { $match: { createdAt: { $gte: start, $lte: end } } },
                            {
                                $group: {
                                    _id: null,
                                    revenue: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$total_price', 0] } },
                                    paid_orders: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
                                    cancelled_orders: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
                                },
                            },
                        ],
                        // Customers Served: unique customers with a *paid* order in the window
                        // (PRD-literal).
                        customers_served: [
                            { $match: { createdAt: { $gte: start, $lte: end }, status: 'paid', customer_mobile: { $nin: [null, ''] } } },
                            { $group: { _id: '$customer_mobile' } },
                            { $count: 'count' },
                        ],
                        // New Customers: customers whose *first ever* order with this business falls
                        // inside the window. One group per customer, no cross-window list to diff.
                        new_customers: [
                            { $match: { customer_mobile: { $nin: [null, ''] } } },
                            { $group: { _id: '$customer_mobile', first_order: { $min: '$createdAt' } } },
                            { $match: { first_order: { $gte: start, $lte: end } } },
                            { $count: 'count' },
                        ],
                    },
                },
            ]),
            OrderRating.aggregate([
                // Narrow on the indexed submitted_at first. This $match used to sit *after* the
                // $lookup, so every rating the platform had ever collected — across every business —
                // was joined to its order before anything was filtered out.
                { $match: { submitted_at: { $gte: start, $lte: end } } },
                {
                    $lookup: {
                        from: 'orders',
                        localField: 'order_id',
                        foreignField: '_id',
                        as: 'order',
                        pipeline: [{ $project: { business_id: 1 } }],
                    },
                },
                { $unwind: '$order' },
                { $match: { 'order.business_id': new mongoose.Types.ObjectId(req.user.businessId) } },
                {
                    $group: {
                        _id: null,
                        avg_overall: { $avg: '$overall_rating' },
                        count: { $sum: 1 },
                    },
                },
            ]),
        ]);
        const f = stats[0] ?? {};
        const totals = f.window_totals?.[0] ?? {};
        res.json({
            total_revenue: totals.revenue || 0,
            customer_rating: ratingsAgg[0]?.avg_overall ? Number(ratingsAgg[0].avg_overall.toFixed(1)) : null,
            customers_served: f.customers_served?.[0]?.count || 0,
            new_customers: f.new_customers?.[0]?.count || 0,
            completed_orders: totals.paid_orders || 0,
            cancelled_orders: totals.cancelled_orders || 0,
            timeframe: timeframe && TIMEFRAME_DAYS[timeframe] ? timeframe : 'monthly',
        });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// GET /api/dashboard/onboarding
router.get('/onboarding', async (req, res) => {
    try {
        const { Service } = await import('../models.js');
        const [branchCount, serviceCount, staffCount] = await Promise.all([
            Branch.countDocuments({ business_id: req.user.businessId, deleted_at: null }),
            Service.countDocuments({ business_id: req.user.businessId, deleted_at: null }),
            // Worker + Manager count
            (await import('../models.js')).User.countDocuments({
                business_id: req.user.businessId,
                role: { $in: ['manager', 'worker'] },
                deleted_at: null,
            }),
        ]);
        res.json({ has_branch: branchCount > 0, has_services: serviceCount > 0, has_staff: staffCount > 0 });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
export default router;
