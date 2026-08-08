import { Router } from 'express';
import { FeatureEvent } from '../models.js';
import { sessionVerification, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(sessionVerification);

// POST /api/analytics/track — minimal feature-usage tracking per the PRD's "Feature
// Tracking" requirement on every page. Called fire-and-forget from the client; kept
// intentionally minimal, not a full analytics pipeline.
//
// Acknowledged before the write rather than after it. The client already treats this as
// fire-and-forget and ignores the body, but the server was still holding the response open
// for a database round trip — on every tracked interaction of every user, which is the single
// most frequent request the API serves. The insert still happens; nothing waits on it, and a
// failure is logged rather than returned, because there is no caller left to tell and a
// dropped analytics event must never surface as an error in the UI.
router.post('/track', (req: AuthRequest, res) => {
  const { feature_key, metadata } = req.body;
  if (!feature_key) return res.status(400).json({ message: 'feature_key is required' });

  res.status(202).json({ message: 'accepted' });

  FeatureEvent.create({
    business_id: req.user!.businessId || null,
    user_id: req.user!.id,
    feature_key,
    metadata: metadata || {},
  }).catch((err: any) => console.error('[analytics] track failed (non-fatal):', err.message));
});

export default router;
