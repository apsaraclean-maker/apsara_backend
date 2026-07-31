import { Router } from 'express';
import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { Business, User, Branch, Service, OrderRating } from '../models.js';
import { sessionVerification, authorizeRoles } from '../middleware/auth.js';
import { decryptPin, encryptPin, generatePin } from '../utils/pinCrypto.js';
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
    const { name, gst_number, social_link, website, facebook_url, instagram_url, phone, address, pincode, state } = req.body;
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
        if (website !== undefined)
            business.website = website;
        if (facebook_url !== undefined)
            business.facebook_url = facebook_url;
        if (instagram_url !== undefined)
            business.instagram_url = instagram_url;
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
        // These three are headline totals ("Branches / Total Services / Total Staffs"), so they
        // count everything that exists for the business — enabled or disabled alike. Only soft
        // deletes are excluded. The active-only counts live on the sidebar, not here.
        const [me, owner, branchesCount, totalServices, totalStaff, ratingAgg] = await Promise.all([
            User.findOne({ _id: req.user.id }).select('name role phone employee_id pin_encrypted'),
            User.findOne({ business_id: business._id, role: 'owner' }).select('name phone'),
            Branch.countDocuments({ business_id: business._id, deleted_at: null }),
            Service.countDocuments({ business_id: business._id, deleted_at: null }),
            User.countDocuments({ business_id: business._id, deleted_at: null, role: { $in: ['manager', 'worker'] } }),
            OrderRating.aggregate([
                { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
                { $unwind: '$order' },
                { $match: { 'order.business_id': new mongoose.Types.ObjectId(business._id), submitted_at: { $ne: null } } },
                { $group: { _id: null, avg: { $avg: '$overall_rating' } } },
            ]),
        ]);
        // Owners registered before they were assigned a PIN have none stored, which would leave
        // the Business Page's PIN tag permanently blank for every existing account. Mint one on
        // first read so those accounts self-heal; it writes at most once per user, and an owner
        // PIN is display-only (owners still authenticate by password).
        let pin = me?.pin_encrypted ? decryptPin(me.pin_encrypted) : null;
        if (me && !me.pin_encrypted) {
            pin = generatePin();
            await User.updateOne({ _id: me._id }, { $set: { pin_encrypted: encryptPin(pin) } });
        }
        res.json({
            user: {
                name: me?.name,
                role: me?.role,
                phone: me?.phone,
                employee_id: me?.employee_id || null,
                pin,
            },
            business: {
                name: business.name,
                gst_number: business.gst_number,
                // Figma's "Business Number" is the business's own line, not the owner's personal
                // mobile — the two are shown as separate values on the page.
                phone: business.phone,
                social_link: business.social_link,
                website: business.website || business.social_link || '',
                facebook_url: business.facebook_url,
                instagram_url: business.instagram_url,
                owner_name: owner?.name || '',
                owner_mobile: owner?.phone || '',
                overall_rating: ratingAgg[0]?.avg ? Math.round(ratingAgg[0].avg * 10) / 10 : null,
                branches_count: branchesCount,
                total_services: totalServices,
                total_staff: totalStaff,
            },
        });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
export default router;
