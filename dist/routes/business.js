import { Router } from 'express';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { Business, User, Branch, Service, OrderRating } from '../models.js';
import { sessionVerification, authorizeRoles } from '../middleware/auth.js';
import { decryptPin } from '../utils/pinCrypto.js';
const router = Router();
router.use(sessionVerification);
// GET /api/business/profile
router.get('/profile', async (req, res) => {
    try {
        const business = await Business.findById(req.user.businessId);
        if (!business)
            return res.status(404).json({ message: 'Business not found' });
        res.json(business);
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// PUT /api/business/profile
router.put('/profile', authorizeRoles('owner'), async (req, res) => {
    const { name, gst_number, social_link, phone, address, pincode, state } = req.body;
    try {
        const business = await Business.findById(req.user.businessId);
        if (!business)
            return res.status(404).json({ message: 'Business not found' });
        if (name)
            business.name = name;
        if (gst_number !== undefined)
            business.gst_number = gst_number;
        if (social_link !== undefined)
            business.social_link = social_link;
        if (phone !== undefined)
            business.phone = phone;
        if (address !== undefined)
            business.address = address;
        if (pincode !== undefined)
            business.pincode = pincode;
        if (state !== undefined)
            business.state = state;
        business.updatedAt = DateTime.now().toUTC().toISO();
        await business.save();
        res.json(business);
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// GET /api/business/overview — the Business Page's Overview section: the logged-in
// user's own details (visible to every persona, including their own Emp. ID/PIN) plus
// business-wide details (owner name/mobile, rating, GST, counts) that every persona
// can see per the PRD's Business Page rules.
router.get('/overview', async (req, res) => {
    try {
        const business = await Business.findById(req.user.businessId);
        if (!business)
            return res.status(404).json({ message: 'Business not found' });
        const [me, owner, branchesCount, activeServices, activeStaff, ratingAgg] = await Promise.all([
            User.findOne({ _id: req.user.id }).select('name role phone employee_id pin_encrypted'),
            User.findOne({ business_id: business._id, role: 'owner' }).select('name phone'),
            Branch.countDocuments({ business_id: business._id, deleted_at: null }),
            Service.countDocuments({ business_id: business._id, deleted_at: null, is_active: true }),
            User.countDocuments({ business_id: business._id, deleted_at: null, is_active: true, role: { $in: ['manager', 'worker'] } }),
            OrderRating.aggregate([
                { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
                { $unwind: '$order' },
                { $match: { 'order.business_id': new mongoose.Types.ObjectId(business._id), submitted_at: { $ne: null } } },
                { $group: { _id: null, avg: { $avg: '$overall_rating' } } },
            ]),
        ]);
        res.json({
            user: {
                name: me?.name,
                role: me?.role,
                phone: me?.phone,
                employee_id: me?.employee_id || null,
                pin: me?.pin_encrypted ? decryptPin(me.pin_encrypted) : null,
            },
            business: {
                name: business.name,
                gst_number: business.gst_number,
                social_link: business.social_link,
                owner_name: owner?.name || '',
                owner_mobile: owner?.phone || '',
                overall_rating: ratingAgg[0]?.avg ? Math.round(ratingAgg[0].avg * 10) / 10 : null,
                branches_count: branchesCount,
                active_services: activeServices,
                active_staff: activeStaff,
            },
        });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
export default router;
