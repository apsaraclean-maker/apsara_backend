import { Router } from 'express';
import axios from 'axios';
import { sessionVerification } from '../middleware/auth.js';

const router = Router();
router.use(sessionVerification);

// Proxies Nominatim (OpenStreetMap) so we can set a proper User-Agent — Nominatim's usage
// policy requires one identifying the application, and browsers silently strip/override any
// User-Agent a client sets on a direct fetch, so this can't be called client-side.
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'ApsaraCleanLaundryApp/1.0 (contact: apsara.clean@gmail.com)';

// GET /api/geocode/reverse?lat=&lng= — used by the Create Branch map picker to autofill
// address line, pincode, city and state from the dropped pin.
router.get('/reverse', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ message: 'lat and lng are required' });

  try {
    const response = await axios.get(`${NOMINATIM_BASE}/reverse`, {
      params: { lat, lon: lng, format: 'jsonv2', addressdetails: 1 },
      headers: { 'User-Agent': USER_AGENT },
    });

    const addr = response.data?.address || {};
    res.json({
      display_name: response.data?.display_name || '',
      address_line_1: [addr.road, addr.suburb].filter(Boolean).join(', '),
      city: addr.city || addr.town || addr.village || addr.county || '',
      state: addr.state || '',
      pincode: addr.postcode || '',
    });
  } catch (err: any) {
    res.status(502).json({ message: 'Reverse geocoding failed' });
  }
});

// GET /api/geocode/search?q= — forward geocoding for the map picker's address search box
// (jump the map to a typed address rather than only allowing click-to-place).
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ message: 'q is required' });

  try {
    const response = await axios.get(`${NOMINATIM_BASE}/search`, {
      params: { q: `${q}, India`, format: 'jsonv2', addressdetails: 1, limit: 5, countrycodes: 'in' },
      headers: { 'User-Agent': USER_AGENT },
    });

    res.json(
      (response.data || []).map((r: any) => ({
        display_name: r.display_name,
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
      }))
    );
  } catch (err: any) {
    res.status(502).json({ message: 'Geocode search failed' });
  }
});

export default router;
