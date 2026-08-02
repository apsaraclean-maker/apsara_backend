import mongoose from 'mongoose';
import { DateTime } from 'luxon';

export const getUTCNow = () => DateTime.now().toUTC().toISO()!;
export const getUTCNowAsDate = () => DateTime.now().toUTC().toJSDate();

export type UserRole = 'admin' | 'owner' | 'manager' | 'worker';
export type OrderStatus = 'created' | 'in_progress' | 'completed' | 'paid' | 'cancelled';
export type PricingMode = 'unit' | 'kg';
export type BusinessStatus = 'active' | 'inactive' | 'blocked';

// ─── Business ────────────────────────────────────────────────────────────────

const businessSchema = new mongoose.Schema({
  name: { type: String, required: true },
  gst_number: { type: String, default: '' },
  // social_link predates the Business Page design, which splits the socials into three
  // named links (Figma node 860:20114). It is kept as the Website fallback for businesses
  // created before `website` existed.
  social_link: { type: String, default: '' },
  website: { type: String, default: '' },
  facebook_url: { type: String, default: '' },
  instagram_url: { type: String, default: '' },
  owner_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  overall_rating_cache: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'inactive', 'blocked'], default: 'active' },
  phone: { type: String, default: '' },
  address: { type: String, default: '' },
  pincode: { type: String, default: '' },
  state: { type: String, default: '' },
  createdAt: { type: String, default: getUTCNow },
  updatedAt: { type: String, default: getUTCNow },
});
businessSchema.index({ owner_id: 1 });
businessSchema.index({ status: 1 });
export const Business = mongoose.model('Business', businessSchema);

// ─── Branch ──────────────────────────────────────────────────────────────────

const branchSchema = new mongoose.Schema({
  business_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  name: { type: String, required: true },
  branch_code: { type: String, required: true },
  address_line_1: { type: String, default: '' },
  address_line_2: { type: String, default: '' },
  pincode: { type: String, default: '' },
  city: { type: String, default: '' },
  state: { type: String, default: '' },
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  deleted_at: { type: String, default: null },
  createdAt: { type: String, default: getUTCNow },
  updatedAt: { type: String, default: getUTCNow },
});
branchSchema.index({ business_id: 1, deleted_at: 1 });
branchSchema.index({ business_id: 1, branch_code: 1 }, { unique: true });
export const Branch = mongoose.model('Branch', branchSchema);

// ─── User ─────────────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  business_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  password_hash: { type: String, required: true },
  pin_encrypted: { type: String, default: null },
  role: { type: String, enum: ['admin', 'owner', 'manager', 'worker'], required: true },
  employee_id: { type: String, default: null },
  is_active: { type: Boolean, default: true },
  failed_login_count: { type: Number, default: 0 },
  locked_until: { type: String, default: null },
  deleted_at: { type: String, default: null },
  createdAt: { type: String, default: getUTCNow },
  updatedAt: { type: String, default: getUTCNow },
});
userSchema.index({ business_id: 1, role: 1 });
// Phone uniqueness only applies to non-deleted accounts — a plain `unique: true` on the
// field meant a soft-deleted user (staff removed, or a deleted business's owner) held onto
// their phone number forever, blocking anyone else on the entire platform from ever using
// it again until the eventual 3-month hard-delete purge. Partial index scopes the
// uniqueness constraint to `deleted_at: null` so it frees up immediately on delete instead.
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { deleted_at: null } });
// Guards against the race condition in generateEmployeeId() (staff.ts) — two concurrent
// "add manager" requests could otherwise both read the same existing-IDs list and compute
// the same new employee_id before either write lands. Partial index (only documents where
// employee_id is an actual string) so workers, who always have employee_id: null, don't
// collide with each other.
userSchema.index(
  { business_id: 1, employee_id: 1 },
  { unique: true, partialFilterExpression: { employee_id: { $type: 'string' } } }
);
export const User = mongoose.model('User', userSchema);

// ─── UserBranch (junction) ────────────────────────────────────────────────────

const userBranchSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
});
userBranchSchema.index({ user_id: 1, branch_id: 1 }, { unique: true });
userBranchSchema.index({ branch_id: 1 });
export const UserBranch = mongoose.model('UserBranch', userBranchSchema);

// ─── Service ──────────────────────────────────────────────────────────────────

const serviceSchema = new mongoose.Schema({
  business_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  name: { type: String, required: true },
  article_type: { type: String, default: '' },
  washing_method: { type: String, default: '' },
  unit_price: { type: Number, default: 0 },
  weight_price: { type: Number, default: 0 },
  is_active: { type: Boolean, default: true },
  notes: { type: String, default: '' },
  deleted_at: { type: String, default: null },
  createdAt: { type: String, default: getUTCNow },
  updatedAt: { type: String, default: getUTCNow },
});
serviceSchema.index({ business_id: 1, deleted_at: 1 });
export const Service = mongoose.model('Service', serviceSchema);

// ─── BranchService (junction) ─────────────────────────────────────────────────

const branchServiceSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  service_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
});
branchServiceSchema.index({ branch_id: 1, service_id: 1 }, { unique: true });
branchServiceSchema.index({ service_id: 1 });
export const BranchService = mongoose.model('BranchService', branchServiceSchema);

// ─── Order ────────────────────────────────────────────────────────────────────

const orderSchema = new mongoose.Schema({
  order_number: { type: String, unique: true, required: true },
  business_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Every other identity-bearing field on an order (service name, article type, washing
  // method) is deliberately snapshotted so historical orders stay meaningful even after the
  // source record changes — created_by wasn't, so an order created by a staff member who's
  // since been hard-deleted (post 3-month purge) would silently lose "who created this"
  // entirely once populate('created_by') resolves to null.
  created_by_name_snapshot: { type: String, default: '' },
  customer_name: { type: String, required: true },
  customer_mobile: { type: String, default: '' },
  status: { type: String, enum: ['created', 'in_progress', 'completed', 'paid', 'cancelled'], default: 'created' },
  delivery_due_date: { type: String, default: null },
  // When the order last reached "completed". Delay is judged against this rather than
  // against the clock, so an order that missed its due date stays marked as delayed once
  // it's finished — see utils/orderDelay.ts. Stamped on every entry into `completed`, so
  // stepping back to in_progress and finishing again records the later, real completion.
  completed_at: { type: String, default: null },
  extra_charges: { type: Number, default: 0 },
  extra_charges_reason: { type: String, default: '' },
  total_price: { type: Number, required: true },
  is_delayed: { type: Boolean, default: false },
  notes: { type: String, default: '' },
  deleted_at: { type: String, default: null },
  createdAt: { type: String, default: getUTCNow },
  updatedAt: { type: String, default: getUTCNow },
});
orderSchema.index({ business_id: 1, createdAt: -1 });
orderSchema.index({ business_id: 1, branch_id: 1, status: 1 });
orderSchema.index({ business_id: 1, deleted_at: 1 });
export const Order = mongoose.model('Order', orderSchema);

// ─── OrderService ─────────────────────────────────────────────────────────────

const orderServiceSchema = new mongoose.Schema({
  order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  service_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', default: null },
  service_name_snapshot: { type: String, required: true },
  article_type_snapshot: { type: String, default: '' },
  washing_method_snapshot: { type: String, default: '' },
  pricing_mode: { type: String, enum: ['unit', 'kg'], default: 'unit' },
  quantity: { type: Number, default: 1 },
  unit_price_snapshot: { type: Number, required: true },
  line_total: { type: Number, required: true },
});
orderServiceSchema.index({ order_id: 1 });
export const OrderService = mongoose.model('OrderService', orderServiceSchema);

// ─── OrderImage ───────────────────────────────────────────────────────────────

const orderImageSchema = new mongoose.Schema({
  order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  image_url: { type: String, required: true },
  file_size_bytes: { type: Number, default: 0 },
  sort_order: { type: Number, default: 0 },
  createdAt: { type: String, default: getUTCNow },
});
orderImageSchema.index({ order_id: 1, sort_order: 1 });
export const OrderImage = mongoose.model('OrderImage', orderImageSchema);

// ─── OrderStatusHistory ───────────────────────────────────────────────────────

const orderStatusHistorySchema = new mongoose.Schema({
  order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  status: { type: String, required: true },
  changed_at: { type: String, default: getUTCNow },
  changed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
});
orderStatusHistorySchema.index({ order_id: 1, changed_at: -1 });
export const OrderStatusHistory = mongoose.model('OrderStatusHistory', orderStatusHistorySchema);

// ─── OrderRating ──────────────────────────────────────────────────────────────

const orderRatingSchema = new mongoose.Schema({
  order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
  rating_token: { type: String, required: true, unique: true },
  overall_rating: { type: Number, min: 1, max: 5, default: null },
  speed_rating: { type: Number, min: 1, max: 5, default: null },
  quality_rating: { type: Number, min: 1, max: 5, default: null },
  submitted_at: { type: String, default: null },
  createdAt: { type: String, default: getUTCNow },
});
export const OrderRating = mongoose.model('OrderRating', orderRatingSchema);

// ─── OrderDailyCounter ────────────────────────────────────────────────────────

const orderDailyCounterSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  order_date: { type: String, required: true },
  last_counter: { type: Number, default: 0 },
});
orderDailyCounterSchema.index({ branch_id: 1, order_date: 1 }, { unique: true });
export const OrderDailyCounter = mongoose.model('OrderDailyCounter', orderDailyCounterSchema);

// ─── FeatureEvent ─────────────────────────────────────────────────────────────

const featureEventSchema = new mongoose.Schema({
  business_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  feature_key: { type: String, required: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: String, default: getUTCNow },
});
featureEventSchema.index({ business_id: 1, feature_key: 1 });
featureEventSchema.index({ createdAt: -1 });
export const FeatureEvent = mongoose.model('FeatureEvent', featureEventSchema);

// ─── Master: Article ──────────────────────────────────────────────────────────

const articleSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  createdAt: { type: String, default: getUTCNow },
});
export const Article = mongoose.model('Article', articleSchema);

// ─── Master: WashingMethod ────────────────────────────────────────────────────

const washingMethodSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  createdAt: { type: String, default: getUTCNow },
});
export const WashingMethod = mongoose.model('WashingMethod', washingMethodSchema);

// ─── OTP ─────────────────────────────────────────────────────────────────────

const otpSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  otp: { type: String, required: true },
  createdAt: { type: Date, default: getUTCNowAsDate, expires: 600 },
});
export const OTP = mongoose.model('OTP', otpSchema);

// ─── ActiveSession ────────────────────────────────────────────────────────────
// Tracks each logged-in session per user so login can enforce a device-count limit and
// show the caller which devices are currently active. TTL matches the session cookie's
// fixed 7-day maxAge (server.ts) — not a sliding expiry, since the cookie itself isn't one.

const activeSessionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  session_id: { type: String, required: true, unique: true },
  device_label: { type: String, default: 'Unknown device' },
  ip_address: { type: String, default: '' },
  createdAt: { type: Date, default: getUTCNowAsDate, expires: 7 * 24 * 60 * 60 },
});
activeSessionSchema.index({ user_id: 1 });
export const ActiveSession = mongoose.model('ActiveSession', activeSessionSchema);

// ─── AdminUser ────────────────────────────────────────────────────────────────

const adminUserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  username: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  createdAt: { type: String, default: getUTCNow },
  updatedAt: { type: String, default: getUTCNow },
});
export const AdminUser = mongoose.model('AdminUser', adminUserSchema);

// ─── Payment ──────────────────────────────────────────────────────────────────

const paymentSchema = new mongoose.Schema({
  business_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  amount: { type: Number, required: true },
  payment_date: { type: String, required: true },
  payment_mode: {
    type: String,
    required: true,
    enum: ['UPI', 'Cash', 'Bank Transfer', 'NEFT', 'RTGS', 'Cheque'],
  },
  reference_id: { type: String, default: '' },
  bank_name: { type: String, default: '' },
  notes: { type: String, default: '' },
  cycle_start_date: { type: String, required: true },
  cycle_end_date: { type: String, required: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
  createdAt: { type: String, default: getUTCNow },
  updatedAt: { type: String, default: getUTCNow },
});
paymentSchema.index({ business_id: 1, cycle_start_date: 1 });
export const Payment = mongoose.model('Payment', paymentSchema);

// ─── ArchivedUser ─────────────────────────────────────────────────────────────

const archivedUserSchema = new mongoose.Schema({
  original_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  name: String,
  phone: String,
  role: String,
  business_id: mongoose.Schema.Types.ObjectId,
  old_details: mongoose.Schema.Types.Mixed,
  archived_at: { type: String, default: getUTCNow },
  archived_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});
export const ArchivedUser = mongoose.model('ArchivedUser', archivedUserSchema);
