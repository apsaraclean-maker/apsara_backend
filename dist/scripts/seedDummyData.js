// Generates fully-fledged demo data: 3 dummy businesses, each with 2-3 branches, 5-8 staff
// (managers + workers), a handful of services, and 10-15 orders spanning every status/
// rating/delay variation the app supports. Everything created here has "(dummy)" in its
// name so it's trivially recognisable and safe to bulk-delete later.
//
// Replaces the 21 broken legacy-roleId staff accounts found in the live database (integer
// `roleId` with no string `role` at all — unusable under the current auth system) with
// data that actually exercises the rewritten app end-to-end.
//
// Owner accounts still have no self-serve creation path (by design, per the project's
// current decision) — this script is how they get created, same as a manual DB insert
// would have been.
//
// Usage: npx tsx src/scripts/seedDummyData.ts
import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Business, User, Branch, BranchService, UserBranch, Service, Article, WashingMethod, Order, OrderService, OrderStatusHistory, OrderRating, OrderDailyCounter, } from '../models.js';
import { encryptPin, generatePin } from '../utils/pinCrypto.js';
import { nowInBusinessTz } from '../utils/timezone.js';
// ─── Small helpers ──────────────────────────────────────────────────────────────
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
    return arr[randomInt(0, arr.length - 1)];
}
function pickMany(arr, n) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(n, arr.length));
}
function jitter(value, amount) {
    return value + (Math.random() * 2 - 1) * amount;
}
function generateBranchCode(name, existingCodes) {
    const letters = name.toUpperCase().replace(/[^A-Z]/g, '');
    const base = (letters.slice(0, 3) || 'BRN').padEnd(3, 'X');
    const taken = new Set(existingCodes);
    if (!taken.has(base))
        return base;
    const prefix = base.slice(0, 2);
    let lastChar = base.charCodeAt(2);
    for (let i = 0; i < 26; i++) {
        lastChar = lastChar >= 90 ? 65 : lastChar + 1;
        const candidate = prefix + String.fromCharCode(lastChar);
        if (!taken.has(candidate))
            return candidate;
    }
    return base;
}
function generateEmployeeId(name, existingIds) {
    const initials = name.split(' ').map((w) => w[0]?.toUpperCase() || '').join('').slice(0, 2);
    let counter = 0;
    let candidate = `${initials}${counter}`;
    while (existingIds.includes(candidate)) {
        counter++;
        candidate = `${initials}${counter}`;
    }
    return candidate;
}
// Mirrors orders.ts' getNextOrderNumber, but takes an explicit historical date instead of
// always "today", so seeded orders can be spread realistically over the last ~45 days.
const dailyCounters = new Map();
function getSeededOrderNumber(branchId, branchCode, employeeId, date) {
    const dateStr = date.toFormat('yyMMdd');
    const key = `${branchId}:${dateStr}`;
    const next = (dailyCounters.get(key) || 0) + 1;
    dailyCounters.set(key, next);
    const seq = next.toString(36).toUpperCase().padStart(3, '0');
    return `${branchCode}-${employeeId}-${dateStr}-${seq}`;
}
// ─── Fixed pools of variation ───────────────────────────────────────────────────
const CITIES = [
    { city: 'Bengaluru', state: 'Karnataka', lat: 12.9716, lng: 77.5946, pincode: '560001' },
    { city: 'Mumbai', state: 'Maharashtra', lat: 19.0760, lng: 72.8777, pincode: '400001' },
    { city: 'Delhi', state: 'Delhi', lat: 28.7041, lng: 77.1025, pincode: '110001' },
];
const BRANCH_LOCALITIES = ['MG Road', 'Indiranagar', 'Koramangala', 'Andheri West', 'Bandra', 'Powai', 'Connaught Place', 'Karol Bagh', 'Dwarka'];
const CUSTOMER_FIRST = ['Rahul', 'Priya', 'Amit', 'Sneha', 'Vikram', 'Anjali', 'Rohan', 'Kavya', 'Arjun', 'Neha', 'Suresh', 'Divya'];
const CUSTOMER_LAST = ['Sharma', 'Verma', 'Iyer', 'Reddy', 'Gupta', 'Nair', 'Rao', 'Menon', 'Kapoor', 'Joshi'];
const STAFF_FIRST = ['Ravi', 'Pooja', 'Manoj', 'Deepika', 'Sanjay', 'Kiran', 'Ashok', 'Meera', 'Vijay', 'Lakshmi', 'Ganesh', 'Radha'];
const STAFF_LAST = ['Kumar', 'Singh', 'Patel', 'Yadav', 'Naidu', 'Pillai', 'Das', 'Bhatt'];
const BUSINESS_TEMPLATES = [
    { name: 'Sparkle Wash Co.', gst: '29ABCDE1234F1Z5', social: 'https://instagram.com/sparklewash' },
    { name: 'QuickClean Laundry', gst: '27PQRSX5678K1Z2', social: 'https://instagram.com/quickclean' },
    { name: 'Fresh Fold Services', gst: '07LMNOP9012Q1Z8', social: 'https://instagram.com/freshfold' },
];
const ORDER_NOTES = [
    '', '', 'Handle with care, delicate fabric', 'Customer requested extra starch', 'Stain on collar, pre-treated', 'Rush order',
];
const RATING_COMMENTS_EXIST = [true, true, false]; // ~2/3 of paid orders get a submitted rating
let dummyPhoneCounter = 9000000001; // deterministic, avoids collision across reruns within a session
function nextDummyPhone() {
    return String(dummyPhoneCounter++);
}
// ─── Cleanup ────────────────────────────────────────────────────────────────────
async function cleanupPreviousDummyData() {
    const businesses = await Business.find({ name: { $regex: /\(dummy\)$/ } }).select('_id');
    const businessIds = businesses.map((b) => b._id);
    if (!businessIds.length)
        return;
    const [users, branches, orders] = await Promise.all([
        User.find({ business_id: { $in: businessIds } }).select('_id'),
        Branch.find({ business_id: { $in: businessIds } }).select('_id'),
        Order.find({ business_id: { $in: businessIds } }).select('_id'),
    ]);
    const userIds = users.map((u) => u._id);
    const branchIds = branches.map((b) => b._id);
    const orderIds = orders.map((o) => o._id);
    await Promise.all([
        OrderService.deleteMany({ order_id: { $in: orderIds } }),
        OrderStatusHistory.deleteMany({ order_id: { $in: orderIds } }),
        OrderRating.deleteMany({ order_id: { $in: orderIds } }),
        OrderDailyCounter.deleteMany({ branch_id: { $in: branchIds } }),
        BranchService.deleteMany({ branch_id: { $in: branchIds } }),
        UserBranch.deleteMany({ $or: [{ branch_id: { $in: branchIds } }, { user_id: { $in: userIds } }] }),
    ]);
    await Order.deleteMany({ _id: { $in: orderIds } });
    await Service.deleteMany({ business_id: { $in: businessIds } });
    await Branch.deleteMany({ _id: { $in: branchIds } });
    await User.deleteMany({ _id: { $in: userIds } });
    await Business.deleteMany({ _id: { $in: businessIds } });
    console.log(`Cleaned up ${businessIds.length} previous dummy business(es) and all related data.`);
}
async function scrapLegacyRoleIdStaff() {
    const users = mongoose.connection.collection('users');
    const legacyFilter = { roleId: { $exists: true }, role: { $exists: false } };
    const userIds = (await users.find(legacyFilter, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
    if (userIds.length)
        await UserBranch.deleteMany({ user_id: { $in: userIds } });
    const result = await users.deleteMany(legacyFilter);
    console.log(`Scrapped ${result.deletedCount} legacy roleId-only staff account(s).`);
}
// ─── Main seed ──────────────────────────────────────────────────────────────────
async function seedOneBusiness(template, homeCity) {
    const ownerPhone = nextDummyPhone();
    const ownerPasswordHash = await bcrypt.hash('Dummy@123', 10);
    const owner = await User.create({
        name: `${pick(STAFF_FIRST)} ${pick(STAFF_LAST)} (dummy)`,
        phone: ownerPhone,
        password_hash: ownerPasswordHash,
        role: 'owner',
        pin_encrypted: encryptPin(generatePin()),
        is_active: true,
    });
    const business = await Business.create({
        name: `${template.name} (dummy)`,
        gst_number: template.gst,
        social_link: template.social,
        owner_id: owner._id,
        phone: ownerPhone,
        address: `${randomInt(1, 200)}, ${homeCity.city} (dummy)`,
        pincode: homeCity.pincode,
        state: homeCity.state,
        status: 'active',
    });
    owner.business_id = business._id;
    // Matches register-business: name-derived, and assigned only once business_id is set so
    // the unique (business_id, employee_id) index scopes it per business.
    owner.employee_id = generateEmployeeId(owner.name, []);
    await owner.save();
    // ── Branches ──
    const branchCount = randomInt(2, 3);
    const branchCodes = [];
    const branches = [];
    for (let i = 0; i < branchCount; i++) {
        const locality = pick(BRANCH_LOCALITIES);
        const name = `${locality} Branch (dummy)`;
        const branch_code = generateBranchCode(name, branchCodes);
        branchCodes.push(branch_code);
        const branch = await Branch.create({
            business_id: business._id,
            name,
            branch_code,
            address_line_1: `${randomInt(1, 150)}, ${locality} Main Road (dummy)`,
            address_line_2: i % 2 === 0 ? `Near ${locality} Metro Station (dummy)` : '',
            pincode: homeCity.pincode,
            city: homeCity.city,
            state: homeCity.state,
            latitude: jitter(homeCity.lat, 0.05),
            longitude: jitter(homeCity.lng, 0.05),
        });
        branches.push(branch);
    }
    // ── Staff (5-8): 1-2 managers, rest workers ──
    const staffCount = randomInt(5, 8);
    const managerCount = randomInt(1, 2);
    // Seeded with the owner's ID — owners and managers share one Emp. ID namespace, so a
    // manager computing against an empty list could land on the ID the owner already holds.
    const managerEmpIds = [owner.employee_id];
    const staff = [];
    for (let i = 0; i < staffCount; i++) {
        const role = i < managerCount ? 'manager' : 'worker';
        const name = `${pick(STAFF_FIRST)} ${pick(STAFF_LAST)} (dummy)`;
        const phone = nextDummyPhone();
        const pin = String(randomInt(1000, 9999));
        const password_hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
        let employee_id = null;
        if (role === 'manager') {
            employee_id = generateEmployeeId(name, managerEmpIds);
            managerEmpIds.push(employee_id);
        }
        const user = await User.create({
            business_id: business._id,
            name,
            phone,
            password_hash,
            pin_encrypted: encryptPin(pin),
            role,
            employee_id,
            // One inactive staff member for variation, if we have enough headcount to spare.
            is_active: !(staffCount >= 6 && i === staffCount - 1),
        });
        staff.push(user);
        const assignedBranches = pickMany(branches, randomInt(1, Math.min(2, branches.length)));
        await UserBranch.insertMany(assignedBranches.map((b) => ({ user_id: user._id, branch_id: b._id })));
    }
    const managers = staff.filter((s) => s.role === 'manager');
    const creators = [owner, ...managers]; // only owner/manager create orders, per PRD persona rules
    // ── Services (4-6), linked to a subset of branches each ──
    const [articles, washingMethods] = await Promise.all([
        Article.find().select('name'),
        WashingMethod.find().select('name'),
    ]);
    const serviceCount = randomInt(4, 6);
    const services = [];
    for (let i = 0; i < serviceCount; i++) {
        const pricingIsKg = Math.random() > 0.5;
        const service = await Service.create({
            business_id: business._id,
            name: `${pick(articles).name} ${pricingIsKg ? 'Weight' : 'Unit'} Wash (dummy)`,
            article_type: pick(articles).name,
            washing_method: pick(washingMethods).name,
            unit_price: pricingIsKg ? 0 : randomInt(20, 150),
            weight_price: pricingIsKg ? randomInt(80, 250) : 0,
            notes: 'Standard care instructions (dummy service).',
            is_active: !(i === serviceCount - 1 && serviceCount >= 5), // one inactive, for variation
        });
        services.push(service);
        const linkedBranches = pickMany(branches, randomInt(1, branches.length));
        await BranchService.insertMany(linkedBranches.map((b) => ({ branch_id: b._id, service_id: service._id })));
    }
    // ── Orders (10-15), spread over the last 45 days, every status/variation ──
    const orderCount = randomInt(10, 15);
    const statusPlan = [];
    for (let i = 0; i < orderCount; i++) {
        const r = i / orderCount;
        // Weighted spread: mostly paid/completed (realistic history), some in-flight, a few cancelled.
        if (r < 0.45)
            statusPlan.push('paid');
        else if (r < 0.65)
            statusPlan.push('completed');
        else if (r < 0.8)
            statusPlan.push('in_progress');
        else if (r < 0.92)
            statusPlan.push('created');
        else
            statusPlan.push('cancelled');
    }
    for (let i = 0; i < orderCount; i++) {
        const branch = pick(branches);
        const creator = pick(creators);
        const employeeId = creator.employee_id || 'OWN';
        const status = statusPlan[i];
        const createdAt = nowInBusinessTz().minus({ days: randomInt(1, 45), hours: randomInt(0, 23) });
        const isDelayed = status !== 'cancelled' && status !== 'paid' && Math.random() < 0.25;
        const dueDate = isDelayed
            ? createdAt.plus({ days: randomInt(1, 3) }) // already in the past relative to "now"
            : createdAt.plus({ days: randomInt(3, 10) });
        const branchServices = await BranchService.find({ branch_id: branch._id }).select('service_id');
        const availableServices = services.filter((s) => branchServices.some((bs) => String(bs.service_id) === String(s._id)));
        const chosenServices = pickMany(availableServices.length ? availableServices : services, randomInt(1, 3));
        let total_price = 0;
        const lineItems = chosenServices.map((s) => {
            const pricingMode = s.weight_price > 0 ? 'kg' : 'unit';
            const quantity = randomInt(1, 3);
            const unit_price = pricingMode === 'kg' ? s.weight_price : s.unit_price;
            const line_total = unit_price * quantity;
            total_price += line_total;
            return {
                service_id: s._id,
                service_name_snapshot: s.name,
                article_type_snapshot: s.article_type,
                washing_method_snapshot: s.washing_method,
                pricing_mode: pricingMode,
                quantity,
                unit_price_snapshot: unit_price,
                line_total,
            };
        });
        const hasExtraCharge = Math.random() < 0.3;
        const extra_charges = hasExtraCharge ? randomInt(20, 100) : 0;
        total_price += extra_charges;
        const order_number = getSeededOrderNumber(String(branch._id), branch.branch_code, employeeId, createdAt);
        const order = await Order.create({
            order_number,
            business_id: business._id,
            branch_id: branch._id,
            created_by: creator._id,
            customer_name: `${pick(CUSTOMER_FIRST)} ${pick(CUSTOMER_LAST)} (dummy)`,
            customer_mobile: nextDummyPhone(),
            status,
            delivery_due_date: dueDate.toUTC().toISO(),
            extra_charges,
            extra_charges_reason: hasExtraCharge ? 'Stain removal treatment (dummy)' : '',
            total_price,
            is_delayed: isDelayed,
            notes: pick(ORDER_NOTES),
            createdAt: createdAt.toUTC().toISO(),
            updatedAt: createdAt.toUTC().toISO(),
        });
        if (lineItems.length)
            await OrderService.insertMany(lineItems.map((li) => ({ ...li, order_id: order._id })));
        // Status history mirrors the real progression up to the final status.
        const progression = status === 'cancelled' ? ['created'] :
            status === 'created' ? ['created'] :
                status === 'in_progress' ? ['created', 'in_progress'] :
                    status === 'completed' ? ['created', 'in_progress', 'completed'] :
                        ['created', 'in_progress', 'completed', 'paid'];
        let historyTime = createdAt;
        for (const stepStatus of progression) {
            await OrderStatusHistory.create({ order_id: order._id, status: stepStatus, changed_by: creator._id, changed_at: historyTime.toUTC().toISO() });
            historyTime = historyTime.plus({ hours: randomInt(2, 20) });
        }
        if (status === 'cancelled') {
            await OrderStatusHistory.create({ order_id: order._id, status: 'cancelled', changed_by: creator._id, changed_at: historyTime.toUTC().toISO() });
        }
        const rating_token = crypto.randomBytes(24).toString('hex');
        const wasRated = status === 'paid' && pick(RATING_COMMENTS_EXIST);
        await OrderRating.create({
            order_id: order._id,
            rating_token,
            overall_rating: wasRated ? randomInt(3, 5) : null,
            speed_rating: wasRated ? randomInt(3, 5) : null,
            quality_rating: wasRated ? randomInt(3, 5) : null,
            submitted_at: wasRated ? historyTime.plus({ hours: randomInt(1, 48) }).toUTC().toISO() : null,
        });
    }
    console.log(`Seeded "${business.name}" — ${branches.length} branch(es), ${staff.length} staff, ${services.length} service(s), ${orderCount} order(s). Owner phone: ${ownerPhone} / password: Dummy@123`);
}
async function main() {
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/apsaraclean';
    await mongoose.connect(MONGODB_URI, { family: 4 });
    console.log('Connected to MongoDB');
    await scrapLegacyRoleIdStaff();
    await cleanupPreviousDummyData();
    for (let i = 0; i < BUSINESS_TEMPLATES.length; i++) {
        await seedOneBusiness(BUSINESS_TEMPLATES[i], CITIES[i % CITIES.length]);
    }
    console.log('\nDone. All dummy data is tagged with "(dummy)" for easy identification/cleanup.');
    await mongoose.disconnect();
}
main().catch((err) => {
    console.error('Dummy data seed failed:', err);
    process.exit(1);
});
