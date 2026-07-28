import { Router } from 'express';
import { FeatureEvent } from '../models.js';
import { sessionVerification } from '../middleware/auth.js';
const router = Router();
router.use(sessionVerification);
// POST /api/analytics/track — minimal feature-usage tracking per the PRD's "Feature
// Tracking" requirement on every page. Called fire-and-forget from the client; kept
// intentionally minimal, not a full analytics pipeline.
router.post('/track', async (req, res) => {
    const { feature_key, metadata } = req.body;
    if (!feature_key)
        return res.status(400).json({ message: 'feature_key is required' });
    try {
        await FeatureEvent.create({
            business_id: req.user.businessId || null,
            user_id: req.user.id,
            feature_key,
            metadata: metadata || {},
        });
        res.status(201).json({ message: 'tracked' });
    }
    catch (err) {
        res.status(500).json({ message: err.message });
    }
});
export default router;
