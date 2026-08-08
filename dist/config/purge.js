import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import { Order, OrderService, OrderImage, OrderStatusHistory, OrderRating, Service, User, Branch } from '../models.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
// PRD: "it should be a soft delete in our DB. After 3 months it should be a hard delete" —
// stated for Staff and repeated for Services/Branches/Orders' related data. Approximated
// as 90 days (calendar "3 months" varies 89-92 days; exactness here doesn't matter).
const RETENTION_DAYS = 90;
// Hard-deletes anything that's been soft-deleted (deleted_at set) for longer than the
// retention window. Runs on a daily cron (see server.ts) rather than deleting immediately,
// so there's a recovery grace period before data is actually gone.
export async function purgeExpiredSoftDeletes() {
    const cutoff = DateTime.now().toUTC().minus({ days: RETENTION_DAYS }).toJSDate();
    const expiredFilter = { deleted_at: { $ne: null, $lte: cutoff } };
    const expiredOrders = await Order.find(expiredFilter).select('_id').lean();
    const orderIds = expiredOrders.map((o) => o._id);
    if (orderIds.length) {
        const images = await OrderImage.find({ order_id: { $in: orderIds } }).lean();
        for (const img of images) {
            // image_url/thumb_url are `/uploads/orders/business_<id>/<filename>` (see orders.ts
            // upload route) — reconstruct the on-disk path from them rather than trusting a
            // separate join. Both are removed; the thumbnail would otherwise survive its original.
            for (const url of [img.image_url, img.thumb_url]) {
                if (!url)
                    continue;
                const filePath = path.join(uploadsDir, url.replace(/^\/uploads\//, ''));
                if (fs.existsSync(filePath))
                    fs.unlinkSync(filePath);
            }
        }
        await OrderImage.deleteMany({ order_id: { $in: orderIds } });
        await OrderService.deleteMany({ order_id: { $in: orderIds } });
        await OrderStatusHistory.deleteMany({ order_id: { $in: orderIds } });
        await OrderRating.deleteMany({ order_id: { $in: orderIds } });
        await Order.deleteMany({ _id: { $in: orderIds } });
    }
    // BranchService/UserBranch links, and Order cascades on branch delete, are already
    // cleaned up synchronously at soft-delete time (branches.ts/services.ts) — purging these
    // three is just removing the now-expired soft-deleted document itself.
    const [servicesResult, staffResult, branchesResult] = await Promise.all([
        Service.deleteMany(expiredFilter),
        User.deleteMany(expiredFilter),
        Branch.deleteMany(expiredFilter),
    ]);
    const summary = {
        orders: orderIds.length,
        services: servicesResult.deletedCount,
        staff: staffResult.deletedCount,
        branches: branchesResult.deletedCount,
    };
    console.log('[purge] Hard-deleted expired soft-deletes:', summary);
    return summary;
}
