import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import { Business, User, Payment, AdminUser } from '../models.js';
import { generateAdminToken, adminAuthMiddleware, type AuthRequest } from '../middleware/auth.js';

const router = Router();

function getCurrentBillingCycle(registrationDateStr: string): { cycleStart: string; cycleEnd: string } {
  const regDate = DateTime.fromISO(registrationDateStr).toUTC();
  const regDay = regDate.day;
  const today = DateTime.now().toUTC();

  let cycleStart: DateTime;
  if (today.day >= regDay) {
    cycleStart = today.set({ day: regDay }).startOf('day');
  } else {
    cycleStart = today.minus({ months: 1 }).set({ day: regDay }).startOf('day');
  }
  const cycleEnd = cycleStart.plus({ months: 1 }).minus({ days: 1 }).endOf('day');

  return { cycleStart: cycleStart.toISODate()!, cycleEnd: cycleEnd.toISODate()! };
}

// POST /api/admin/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Username and password required' });
  try {
    const admin = await AdminUser.findOne({ username: username.toLowerCase() });
    if (!admin) return res.status(401).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

    const token = generateAdminToken({ id: admin._id, username: admin.username, name: admin.name });
    res.json({ token, admin: { id: admin._id, name: admin.name, username: admin.username } });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admin/businesses
router.get('/businesses', adminAuthMiddleware, async (_req, res) => {
  try {
    const businesses = await Business.find().sort({ createdAt: -1 });

    const result = await Promise.all(
      businesses.map(async (biz) => {
        const owner = await User.findById(biz.owner_id).select('name phone');
        let paymentLabel = 'N/A';

        if (biz.status === 'active') {
          const { cycleStart } = getCurrentBillingCycle(biz.createdAt);
          const payment = await Payment.findOne({ business_id: biz._id, cycle_start_date: cycleStart });
          paymentLabel = payment ? 'Paid' : 'Delayed';
        }

        return {
          _id: biz._id,
          name: biz.name,
          phone: biz.phone,
          address: biz.address,
          status: biz.status,
          createdAt: biz.createdAt,
          owner_name: owner?.name || '',
          owner_phone: owner?.phone || '',
          payment_label: paymentLabel,
        };
      })
    );

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/admin/businesses/:id
router.put('/businesses/:id', adminAuthMiddleware, async (req, res) => {
  const { name, address, phone, owner_name } = req.body;
  try {
    const business = await Business.findById(req.params.id);
    if (!business) return res.status(404).json({ message: 'Business not found' });

    if (name) business.name = name;
    if (address !== undefined) business.address = address;
    if (phone !== undefined) business.phone = phone;
    business.updatedAt = DateTime.now().toUTC().toISO()!;
    await business.save();

    if (owner_name) {
      await User.findByIdAndUpdate(business.owner_id, { name: owner_name, updatedAt: DateTime.now().toUTC().toISO() });
    }

    res.json(business);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/admin/businesses/:id/status
router.patch('/businesses/:id/status', adminAuthMiddleware, async (req, res) => {
  try {
    const business = await Business.findById(req.params.id);
    if (!business) return res.status(404).json({ message: 'Business not found' });

    business.status = business.status === 'active' ? 'inactive' : 'active';
    business.updatedAt = DateTime.now().toUTC().toISO()!;
    await business.save();

    res.json({ message: `Business ${business.status}`, business });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admin/businesses/:id/payments
router.get('/businesses/:id/payments', adminAuthMiddleware, async (req, res) => {
  try {
    const business = await Business.findById(req.params.id);
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const payments = await Payment.find({ business_id: req.params.id })
      .populate('created_by', 'name username')
      .sort({ cycle_start_date: -1 });

    const { cycleStart, cycleEnd } = getCurrentBillingCycle(business.createdAt);
    const currentCycleHasPayment = payments.some((p) => p.cycle_start_date === cycleStart);

    res.json({
      payments,
      current_cycle: { cycle_start: cycleStart, cycle_end: cycleEnd },
      payment_label: business.status === 'active' ? (currentCycleHasPayment ? 'Paid' : 'Delayed') : 'N/A',
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/businesses/:id/payments
router.post('/businesses/:id/payments', adminAuthMiddleware, async (req: AuthRequest, res) => {
  const { amount, payment_date, payment_mode, reference_id, bank_name, notes, cycle_start_date, cycle_end_date } = req.body;
  if (!amount || !payment_date || !payment_mode || !cycle_start_date || !cycle_end_date) {
    return res.status(400).json({ message: 'amount, payment_date, payment_mode, cycle_start_date, cycle_end_date required' });
  }
  try {
    const existing = await Payment.findOne({ business_id: req.params.id, cycle_start_date });
    if (existing) return res.status(400).json({ message: 'Payment already exists for this billing cycle' });

    const payment = await Payment.create({
      business_id: req.params.id,
      amount: Number(amount),
      payment_date,
      payment_mode,
      reference_id: reference_id || '',
      bank_name: bank_name || '',
      notes: notes || '',
      cycle_start_date,
      cycle_end_date,
      created_by: req.user?.id,
    });

    res.status(201).json(payment);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/admin/payments/:id
router.put('/payments/:id', adminAuthMiddleware, async (req, res) => {
  const { amount, payment_date, payment_mode, reference_id, bank_name, notes, cycle_start_date, cycle_end_date } = req.body;
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });

    if (amount !== undefined) payment.amount = Number(amount);
    if (payment_date) payment.payment_date = payment_date;
    if (payment_mode) payment.payment_mode = payment_mode;
    if (reference_id !== undefined) payment.reference_id = reference_id;
    if (bank_name !== undefined) payment.bank_name = bank_name;
    if (notes !== undefined) payment.notes = notes;
    if (cycle_start_date) payment.cycle_start_date = cycle_start_date;
    if (cycle_end_date) payment.cycle_end_date = cycle_end_date;
    payment.updatedAt = DateTime.now().toUTC().toISO()!;
    await payment.save();

    res.json(payment);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
