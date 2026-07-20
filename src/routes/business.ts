import { Router } from 'express';
import { DateTime } from 'luxon';
import { Business } from '../models.js';
import { sessionVerification, authorizeRoles, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(sessionVerification);

// GET /api/business/profile
router.get('/profile', async (req: AuthRequest, res) => {
  try {
    const business = await Business.findById(req.user!.businessId);
    if (!business) return res.status(404).json({ message: 'Business not found' });
    res.json(business);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/business/profile
router.put('/profile', authorizeRoles('owner'), async (req: AuthRequest, res) => {
  const { name, gst_number, phone, address, pincode, state } = req.body;
  try {
    const business = await Business.findById(req.user!.businessId);
    if (!business) return res.status(404).json({ message: 'Business not found' });

    if (name) business.name = name;
    if (gst_number !== undefined) business.gst_number = gst_number;
    if (phone !== undefined) business.phone = phone;
    if (address !== undefined) business.address = address;
    if (pincode !== undefined) business.pincode = pincode;
    if (state !== undefined) business.state = state;
    business.updatedAt = DateTime.now().toUTC().toISO()!;
    await business.save();

    res.json(business);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
