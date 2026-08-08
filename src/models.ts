import mongoose from 'mongoose';
import { DateTime } from 'luxon';

// Timestamps are stored as BSON Date, not ISO strings — matching the ERD, which types every
// one of these as `timestamp`. Strings worked (they were all UTC 'Z'-suffixed, so
// lexicographic order happened to equal chronological order) but cost real performance:
// index keys ran ~3x larger than an int64 date, so far fewer fit in RAM; comparisons were
// string-wise; `$dateTrunc`/`$dateToString` were unavailable, forcing every date-bucketing
// operation up into JS; and `$expr`-based date comparisons could never use an index.
//
// The wire format is unchanged: JSON.stringify calls Date.prototype.toJSON(), which emits
// the same `2026-08-08T12:00:00.000Z` shape the frontend already parses with
// DateTime.fromISO(). Mongoose also casts ISO strings to Date automatically in query
// filters, so `find({ createdAt: { $gte: someIsoString } })` still works — but aggregation
// pipelines get no such casting, so every `$match` on a date in a pipeline must pass a real
// Date. See scripts/migrateTimestampsToDate.ts for the one-off conversion of existing rows.
export const getUTCNowAsDate = () => DateTime.now().toUTC().toJSDate();

// Date-only business keys (billing cycle boundaries, the daily order-counter key) stay
// strings deliberately — they're exact-match identifiers like "2026-08-08" or "260808", not
// instants, and the ERD types them `date` rather than `timestamp`.

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
  createdAt: { type: Date, default: getUTCNowAsDate },
  updatedAt: { type: Date, default: getUTCNowAsDate },
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
  deleted_at: { type: Date, default: null },
  createdAt: { type: Date, default: getUTCNowAsDate },
  updatedAt: { type: Date, default: getUTCNowAsDate },
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
  // Cumulative across lockouts — deliberately NOT reset when a lockout expires, which is
  // what lets the count climb 10 → 20 → 30 and trip the disable in verifyLogin(). Reset to
  // zero only on a successful login or when an owner/support re-activates the account.
  failed_login_count: { type: Number, default: 0 },
  locked_until: { type: Date, default: null },
  // Bumped whenever a change must invalidate every session this user holds, on every device
  // at once (role change, PIN change, disable). Stamped into the session at login and
  // compared on each request — a mismatch is a 401. Preferred over hunting down and deleting
  // individual sessions because it's atomic and survives a session-store restart.
  session_epoch: { type: Number, default: 0 },
  deleted_at: { type: Date, default: null },
  createdAt: { type: Date, default: getUTCNowAsDate },
  updatedAt: { type: Date, default: getUTCNowAsDate },
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
  deleted_at: { type: Date, default: null },
  createdAt: { type: Date, default: getUTCNowAsDate },
  updatedAt: { type: Date, default: getUTCNowAsDate },
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
  // Unique per business, not globally — see the compound index below. The globally unique
  // handle for an order is its _id, which every order already has and which is never shown
  // to users.
  order_number: { type: String, required: true },
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
  delivery_due_date: { type: Date, default: null },
  // When the order last reached "completed". Delay is judged against this rather than
  // against the clock, so an order that missed its due date stays marked as delayed once
  // it's finished — see utils/orderDelay.ts. Stamped on every entry into `completed`, so
  // stepping back to in_progress and finishing again records the later, real completion.
  completed_at: { type: Date, default: null },
  extra_charges: { type: Number, default: 0 },
  extra_charges_reason: { type: String, default: '' },
  total_price: { type: Number, required: true },
  // Materialised, not derived at query time. The delay rule (utils/orderDelay.ts) is a
  // three-armed $or ending in an $expr comparison of two fields, which no index can serve —
  // so every "delayed" count and filter was a collection scan, including the one on the
  // Dashboard that runs on every load. This field now carries the answer: it is recomputed
  // on the writes that can change it (status change, due-date edit) and swept nightly for
  // open orders that cross their due date with nobody touching them. See recomputeIsDelayed().
  is_delayed: { type: Boolean, default: false },
  notes: { type: String, default: '' },
  deleted_at: { type: Date, default: null },
  createdAt: { type: Date, default: getUTCNowAsDate },
  updatedAt: { type: Date, default: getUTCNowAsDate },
});
// Index set follows ESR (equality → sort → range) against the shapes the routes actually
// issue. Every order query is scoped by business_id + deleted_at, so those two lead
// throughout and the sort or differentiating key trails them.
//
// This replaces {business_id, createdAt}, {business_id, deleted_at} and
// {business_id, branch_id, status}: each of those served either the filter or the sort but
// never both, so the list endpoints were fetching a wide range and then sorting it in
// memory — which Mongo aborts outright past 32MB without a supporting index.
//
// This is a read-heavy collection (every dashboard load, every list, every filter reads it;
// writes are one per order plus a handful of status changes), so paying write amplification
// on these indexes to keep every read path index-backed is the right side of that trade.
// Order numbers are unique *within a business*, not across the platform.
//
// The format is {branchCode}-{employeeId}-{YYMMDD}-{counter} and every component of it is
// business-relative: branch codes are unique per business, employee ids are unique per
// business, and the counter resets daily per branch. Two unrelated businesses that each have
// a "Bandra Branch" and an owner with the same initials will legitimately mint the identical
// string on the same day — which is exactly what is already in this database
// ("BAN-OWN-260624-001" exists once in Sparkle Wash Co. and once in QuickClean Laundry).
//
// A global `unique: true` on the field therefore encoded the wrong rule, and it had never
// actually built: the createIndex failed on that pair every boot and Mongoose's autoIndex
// surfaces build errors on the connection's 'error' event, which nothing listens for. So the
// constraint was silently absent for the whole life of the collection. Scoped to the
// business it builds cleanly and enforces the rule that was meant all along.
//
// The partial filter keeps documents that carry no order_number at all out of the index —
// the collection still holds pre-revamp rows written under the old camelCase schema, which
// have `orderNumber` rather than `order_number` and would otherwise all collide on the same
// (null, null) key.
orderSchema.index(
  { business_id: 1, order_number: 1 },
  { unique: true, partialFilterExpression: { order_number: { $type: 'string' } } }
);
//
// Note the pairing: for each sort order there is one index *without* branch_id and one
// *with* it. That isn't redundancy. A compound index only yields globally-sorted output when
// every key preceding the sort field is pinned to a single value, so an index leading
// (business_id, deleted_at, branch_id, createdAt) produces output sorted by createdAt only
// *within* each branch. An owner listing every branch, or a manager whose branch_id is an
// `$in` over their assignments, would therefore still need a blocking in-memory sort — which
// is precisely what these indexes exist to prevent. Verified with explain(): with branch_id
// ahead of the sort key both list sorts came back as SORT stages over the full match.
orderSchema.index({ business_id: 1, deleted_at: 1, createdAt: -1 });
orderSchema.index({ business_id: 1, deleted_at: 1, branch_id: 1, createdAt: -1 });
// Orders Grid View defaults to "latest interacted" (updatedAt desc) — previously unindexed
// entirely, so that default sort was the one most at risk of hitting the 32MB sort limit.
orderSchema.index({ business_id: 1, deleted_at: 1, updatedAt: -1 });
orderSchema.index({ business_id: 1, deleted_at: 1, branch_id: 1, updatedAt: -1 });
// Status-filtered lists and the Dashboard's per-status counts. status leads createdAt for the
// same reason: it's an equality, the sort key trails it.
orderSchema.index({ business_id: 1, deleted_at: 1, status: 1, createdAt: -1 });
// The "delayed only" filter and the Dashboard's delayed count, now that is_delayed is a
// real stored value rather than a computed predicate.
orderSchema.index({ business_id: 1, deleted_at: 1, branch_id: 1, is_delayed: 1 });
// The Order Timeline's order_due column, and the nightly delay sweep, both range over
// delivery_due_date rather than createdAt.
orderSchema.index({ business_id: 1, deleted_at: 1, delivery_due_date: 1 });
// The Branch Card's per-branch revenue/orders/rating rollups match on branch_id without a
// business_id, which the compound indexes above cannot serve — a compound index is only
// usable from its leading field, so those were collection scans. createdAt trails it because
// the revenue rollup also windows to the current month.
orderSchema.index({ branch_id: 1, createdAt: -1 });
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
// The Orders list's "filter by service" resolves matching orders through this collection.
// service_id was unindexed, so that filter scanned every line item ever written — across
// every business, since the lookup carried no tenant scope of its own. order_id trails it so
// the correlated lookup that replaced that scan (routes/orders.ts) is a pure index hit.
orderServiceSchema.index({ service_id: 1, order_id: 1 });
export const OrderService = mongoose.model('OrderService', orderServiceSchema);

// ─── OrderImage ───────────────────────────────────────────────────────────────

const orderImageSchema = new mongoose.Schema({
  order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  image_url: { type: String, required: true },
  // Populated for images written after the resize pipeline landed; older rows fall back to
  // image_url so the frontend can always render something.
  thumb_url: { type: String, default: '' },
  file_size_bytes: { type: Number, default: 0 },
  sort_order: { type: Number, default: 0 },
  createdAt: { type: Date, default: getUTCNowAsDate },
});
orderImageSchema.index({ order_id: 1, sort_order: 1 });
export const OrderImage = mongoose.model('OrderImage', orderImageSchema);

// ─── OrderStatusHistory ───────────────────────────────────────────────────────

const orderStatusHistorySchema = new mongoose.Schema({
  order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  status: { type: String, required: true },
  changed_at: { type: Date, default: getUTCNowAsDate },
  changed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
});
orderStatusHistorySchema.index({ order_id: 1, changed_at: -1 });
// The Order Timeline and the Orders list's date-range filter both scan this collection by
// (status, changed_at) with no order_id to lead on, which the index above cannot serve.
// Unindexed, those were full scans of the fastest-growing collection in the schema — and
// they run on every dashboard load.
orderStatusHistorySchema.index({ status: 1, changed_at: 1 });
export const OrderStatusHistory = mongoose.model('OrderStatusHistory', orderStatusHistorySchema);

// ─── OrderRating ──────────────────────────────────────────────────────────────

const orderRatingSchema = new mongoose.Schema({
  order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
  rating_token: { type: String, required: true, unique: true },
  overall_rating: { type: Number, min: 1, max: 5, default: null },
  speed_rating: { type: Number, min: 1, max: 5, default: null },
  quality_rating: { type: Number, min: 1, max: 5, default: null },
  submitted_at: { type: Date, default: null },
  createdAt: { type: Date, default: getUTCNowAsDate },
});
// Every rating rollup (Dashboard stats, Business overview) narrows to submitted ratings in a
// window before joining to orders. Without this the pipelines had no indexed entry point and
// had to feed the entire ratings collection into a $lookup.
orderRatingSchema.index({ submitted_at: 1 });
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
  createdAt: { type: Date, default: getUTCNowAsDate },
});
featureEventSchema.index({ business_id: 1, feature_key: 1 });
// TTL rather than a plain index: this collection takes a write on every tracked interaction
// of every user and nothing ever read it back out for more than recent usage, so left alone
// it grows without bound and drags its own insert path down with it. 90 days matches the
// retention window the PRD sets for everything else (config/purge.ts) — raise it here if
// feature analytics ever needs a longer lookback.
featureEventSchema.index({ createdAt: -1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
export const FeatureEvent = mongoose.model('FeatureEvent', featureEventSchema);

// ─── Master: Article ──────────────────────────────────────────────────────────

const articleSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: getUTCNowAsDate },
});
export const Article = mongoose.model('Article', articleSchema);

// ─── Master: WashingMethod ────────────────────────────────────────────────────

const washingMethodSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: getUTCNowAsDate },
});
export const WashingMethod = mongoose.model('WashingMethod', washingMethodSchema);

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
  createdAt: { type: Date, default: getUTCNowAsDate },
  updatedAt: { type: Date, default: getUTCNowAsDate },
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
  // Date-only cycle keys, matched by exact string equality against getCurrentBillingCycle()'s
  // toISODate() output — deliberately not converted to Date with the timestamps above.
  cycle_start_date: { type: String, required: true },
  cycle_end_date: { type: String, required: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
  createdAt: { type: Date, default: getUTCNowAsDate },
  updatedAt: { type: Date, default: getUTCNowAsDate },
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
  archived_at: { type: Date, default: getUTCNowAsDate },
  archived_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});
export const ArchivedUser = mongoose.model('ArchivedUser', archivedUserSchema);
