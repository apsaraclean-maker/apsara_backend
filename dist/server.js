import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import cookieParser from 'cookie-parser';
import { Business, User, Service, Order, OTP, Role, AllStatus, Article, WashingMethod, getUTCNow, ArchivedUser } from './models.js';
import { generateToken, authorizeRoles, sessionVerification } from './auth.js';
import bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dev = process.env.NODE_ENV !== 'production';
const SCHEMA_CONSTANTS = {
    ROLES: { ADMIN: 1, OWNER: 2, STAFF: 3 },
    STATUSES: { INACTIVE: 0, ACTIVE: 1, BLOCKED: 2, CREATED: 3, IN_PROGRESS: 4, COMPLETED: 5 }
};
async function startServer() {
    const app = express();
    const PORT = process.env.PORT;
    // MongoDB Connection
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/laundroflow';
    const seedData = async () => {
        const roles = [
            { role_id: SCHEMA_CONSTANTS.ROLES.ADMIN, role_name: 'admin' },
            { role_id: SCHEMA_CONSTANTS.ROLES.OWNER, role_name: 'owner' },
            { role_id: SCHEMA_CONSTANTS.ROLES.STAFF, role_name: 'staff' }
        ];
        for (const r of roles) {
            await Role.findOneAndUpdate({ role_id: r.role_id }, r, { upsert: true });
        }
        const statuses = [
            { status_id: SCHEMA_CONSTANTS.STATUSES.ACTIVE, status_name: 'user_active' },
            { status_id: SCHEMA_CONSTANTS.STATUSES.INACTIVE, status_name: 'user_inactive' },
            { status_id: SCHEMA_CONSTANTS.STATUSES.BLOCKED, status_name: 'user_blocked' },
            { status_id: SCHEMA_CONSTANTS.STATUSES.CREATED, status_name: 'created' },
            { status_id: SCHEMA_CONSTANTS.STATUSES.IN_PROGRESS, status_name: 'in progress' },
            { status_id: SCHEMA_CONSTANTS.STATUSES.COMPLETED, status_name: 'completed' }
        ];
        for (const s of statuses) {
            await AllStatus.findOneAndUpdate({ status_id: s.status_id }, s, { upsert: true });
        }
        const articles = ['Shirt', 'T-Shirt', 'Jeans', 'Saree', 'Suit', 'Blanket'];
        for (const name of articles) {
            await Article.findOneAndUpdate({ name }, { name }, { upsert: true });
        }
        const washMethods = ['Steam Wash', 'Wet Wash', 'Dry Clean', 'Petrol Wash', 'Ironing Only'];
        for (const name of washMethods) {
            await WashingMethod.findOneAndUpdate({ name }, { name }, { upsert: true });
        }
    };
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB');
        await seedData();
    }
    catch (err) {
        console.error('MongoDB connection error:', err);
        // In a real app, you might want to exit, but here we'll let it try to run
        // maybe Provide a mock/in-memory fallback if needed for the preview?
        // For now, assume user provides URI or local mongo is running.
    }
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(cookieParser());
    // Static files for uploads
    const uploadsDir = path.join(__dirname, "..", 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir);
    }
    app.use('/uploads', express.static(uploadsDir));
    // Multer configuration
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const businessId = req.user?.businessId;
            if (!businessId) {
                return cb(new Error('Business ID not found in session'), '');
            }
            const businessDir = path.join(uploadsDir, 'orders', `business_${businessId}`);
            if (!fs.existsSync(businessDir)) {
                fs.mkdirSync(businessDir, { recursive: true });
            }
            cb(null, businessDir);
        },
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
            cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
        }
    });
    const upload = multer({
        storage,
        limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
        fileFilter: (req, file, cb) => {
            const allowedTypes = /jpeg|jpg|png|webp/;
            const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
            const mimetype = allowedTypes.test(file.mimetype);
            if (extname && mimetype) {
                return cb(null, true);
            }
            cb(new Error('Only images (jpeg, jpg, png, webp) are allowed'));
        }
    });
    const allowedOrigins = [
        "https://funny-llama-333beb.netlify.app",
        "http://localhost:3000"
    ];
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && allowedOrigins.includes(origin)) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Allow-Credentials", "true"); // ✅ required for cookies/auth
        }
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        // ✅ handle preflight requests
        if (req.method === "OPTIONS") {
            return res.sendStatus(200);
        }
        next();
    });
    // Session Configuration
    app.use(session({
        secret: process.env.SESSION_SECRET || 'laundry_session_secret',
        resave: false,
        saveUninitialized: false,
        store: MongoStore.create({
            mongoUrl: MONGODB_URI,
            collectionName: 'sessions'
        }),
        cookie: {
            // maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? "none" : "lax",
            path: "/"
        }
    }));
    console.log(process.env.NODE_ENV);
    app.post('/api/auth/register-business', async (req, res) => {
        const { businessName, ownerName, phone, address, pincode, state, password } = req.body;
        try {
            const existingUser = await User.findOne({ phone });
            if (existingUser)
                return res.status(400).json({ message: 'Phone already registered' });
            // Password hashing
            const hashedPassword = await bcrypt.hash(password, 10);
            // Create owner (verified by default now since we're using password)
            const ownerRole = await Role.findOne({ role_id: SCHEMA_CONSTANTS.ROLES.OWNER });
            const activeStatus = await AllStatus.findOne({ status_id: SCHEMA_CONSTANTS.STATUSES.ACTIVE });
            if (!ownerRole)
                throw new Error('Owner role not found');
            if (!activeStatus)
                throw new Error('Active status not found');
            const user = await User.create({
                name: ownerName,
                phone,
                password: hashedPassword,
                roleId: ownerRole.role_id,
                statusId: activeStatus.status_id,
                isVerified: true
            });
            // Create business (linked to owner)
            const business = await Business.create({
                name: businessName,
                ownerId: user._id,
                address,
                pincode,
                state,
                phone,
                statusId: activeStatus.status_id,
                updatedBy: user._id
            });
            user.businessId = business._id;
            user.updatedBy = user._id;
            await user.save();
            // Automatically login after registration
            const token = generateToken({
                id: user._id,
                role: user.roleId,
                businessId: user.businessId
            });
            req.session.userId = user._id;
            req.session.token = token;
            res.status(201).json({ message: 'Business registered successfully', user, token });
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Verify OTP
    app.post('/api/auth/verify-otp', async (req, res) => {
        const { phone, otp } = req.body;
        try {
            const otpDoc = await OTP.findOne({ phone, otp });
            if (!otpDoc)
                return res.status(400).json({ message: 'Invalid or expired OTP' });
            const user = await User.findOne({ phone });
            if (!user)
                return res.status(404).json({ message: 'User not found' });
            user.isVerified = true;
            user.updatedAt = getUTCNow();
            user.updatedBy = user._id;
            await user.save();
            await OTP.deleteOne({ phone });
            const populatedUser = await User.findById(user._id);
            const token = generateToken({
                id: user._id,
                role: populatedUser?.roleId,
                businessId: user.businessId
            });
            // Set session
            req.session.userId = user._id;
            req.session.token = token;
            console.log("trhsi is cooke in loigin-->", req.session);
            res.json({ message: 'User verified successfully', user, token });
        }
        catch (error) {
            console.log(error, "indside");
            res.status(500).json({ message: error.message });
        }
    });
    // Login (Password based)
    app.post('/api/auth/login', async (req, res) => {
        const { phone, password } = req.body;
        try {
            const user = await User.findOne({ phone });
            if (!user)
                return res.status(404).json({ message: 'Account not found' });
            if (user.statusId !== 1) {
                return res.status(500).json({ message: 'Access Denied' });
            }
            // If user has no password (legacy or staff created without password), they might need to set it
            // But for now, we assume all users have passwords or we allow login if we find a match
            if (!user.password) {
                return res.status(400).json({ message: 'Password not set for this account. Please contact admin.' });
            }
            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch)
                return res.status(400).json({ message: 'Invalid credentials' });
            const token = generateToken({
                id: user._id,
                role: user.roleId,
                businessId: user.businessId
            });
            req.session.userId = user._id;
            req.session.token = token;
            res.json({ message: 'Login successful', user, token });
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Get Staff (Owner only)
    app.get('/api/business/staff', sessionVerification, authorizeRoles(2), async (req, res) => {
        try {
            const staff = await User.find({
                businessId: req.user.businessId,
                roleId: SCHEMA_CONSTANTS.ROLES.STAFF
            }).populate('statusId');
            res.json(staff);
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Add/Edit Staff OTP Request
    app.post('/api/business/staff/request-otp', sessionVerification, authorizeRoles(2), async (req, res) => {
        const { phone } = req.body;
        try {
            // If it's for edit, check if phone changed (this route is general request for any phone)
            // Check if phone already used by someone else in the WHOLE system (since phone is unique)
            const existing = await User.findOne({ phone });
            // If adding new staff, existing is an error. 
            // If editing existing staff, existing.id == staffId is fine.
            // But we just send OTP to the phone provided.
            const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
            await OTP.create({ phone, otp: otpCode });
            // await sendWhatsAppOTP(phone, otpCode);
            // await sendTwilioWhatsAppOTP(phone,String(otpCode))
            res.json({ message: 'OTP sent to WhatsApp', phone });
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Add or Edit Staff (Password based)
    app.post('/api/business/staff', sessionVerification, authorizeRoles(2), async (req, res) => {
        const { name, phone, password, staffId } = req.body;
        const businessId = req.user.businessId;
        try {
            const staffRole = await Role.findOne({ role_id: SCHEMA_CONSTANTS.ROLES.STAFF });
            const activeStatus = await AllStatus.findOne({ status_id: SCHEMA_CONSTANTS.STATUSES.ACTIVE });
            if (!staffRole || !activeStatus)
                throw new Error('Role or Status configuration missing');
            let staff;
            if (staffId) {
                // Edit
                staff = await User.findOne({ _id: staffId, businessId });
                if (!staff)
                    return res.status(404).json({ message: 'Staff not found' });
                staff.name = name;
                staff.phone = phone;
                if (password) {
                    staff.password = await bcrypt.hash(password, 10);
                }
                staff.updatedBy = req.user.id;
                staff.updatedAt = getUTCNow();
                await staff.save();
            }
            else {
                // Add
                const alreadyExists = await User.findOne({ phone });
                if (alreadyExists)
                    return res.status(400).json({ message: 'Phone already in use' });
                const hashedPassword = await bcrypt.hash(password, 10);
                staff = await User.create({
                    name,
                    phone,
                    password: hashedPassword,
                    roleId: staffRole.role_id,
                    statusId: activeStatus.status_id,
                    businessId,
                    isVerified: true,
                    updatedBy: req.user.id
                });
            }
            res.json(staff);
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Delete Staff (Archive)
    app.delete('/api/business/staff/:id', sessionVerification, authorizeRoles(2), async (req, res) => {
        try {
            const staff = await User.findOne({ _id: req.params.id, businessId: req.user.businessId });
            if (!staff)
                return res.status(404).json({ message: 'Staff not found' });
            // Archive
            await ArchivedUser.create({
                originalId: staff._id,
                name: staff.name,
                phone: staff.phone,
                roleId: staff.roleId,
                businessId: staff.businessId,
                statusId: staff.statusId,
                oldDetails: staff.toObject(),
                archivedBy: req.user.id
            });
            // Delete from User
            await User.deleteOne({ _id: staff._id });
            res.json({ message: 'Staff deleted and archived successfully' });
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Create Service (Owner only)
    app.post('/api/business/services', sessionVerification, authorizeRoles(2), async (req, res) => {
        const { name, perUnit, perKg, description, articleId, washingMethodId } = req.body;
        try {
            const businessId = req.user.businessId;
            const service = await Service.create({
                name,
                perUnit: Number(perUnit) || 0,
                perKg: Number(perKg) || 0,
                description,
                articleId,
                washingMethodId,
                businessId,
                updatedBy: req.user.id
            });
            res.json(service);
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Update Service (Owner only)
    app.put('/api/business/services/:id', sessionVerification, authorizeRoles(2), async (req, res) => {
        const { name, perUnit, perKg, description, articleId, washingMethodId } = req.body;
        try {
            const service = await Service.findOne({ _id: req.params.id, businessId: req.user.businessId });
            if (!service)
                return res.status(404).json({ message: 'Service not found' });
            // Check if service is used in active orders (status not paid)
            const usedInActiveOrders = await Order.findOne({
                'services.serviceId': service._id,
                isPaid: false
            });
            if (usedInActiveOrders) {
                return res.status(400).json({ message: 'Cannot edit service while it has active (unpaid) orders.' });
            }
            service.name = name;
            service.perUnit = Number(perUnit) || 0;
            service.perKg = Number(perKg) || 0;
            service.description = description;
            service.articleId = articleId;
            service.washingMethodId = washingMethodId;
            service.updatedBy = req.user.id;
            service.updatedAt = getUTCNow();
            await service.save();
            res.json(service);
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Soft Delete Service
    app.delete('/api/business/services/:id', sessionVerification, authorizeRoles(2), async (req, res) => {
        try {
            const service = await Service.findOne({ _id: req.params.id, businessId: req.user.businessId });
            if (!service)
                return res.status(404).json({ message: 'Service not found' });
            // Check active orders
            const usedInActiveOrders = await Order.findOne({
                'services.serviceId': service._id,
                isPaid: false
            });
            if (usedInActiveOrders) {
                return res.status(400).json({ message: 'Cannot delete service while it has active (unpaid) orders.' });
            }
            service.isDeleted = true;
            service.updatedBy = req.user.id;
            service.updatedAt = getUTCNow();
            await service.save();
            res.json({ message: 'Service deleted (marked inactive) successfully' });
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Get Services (Updated to exclude deleted)
    app.get('/api/business/services', sessionVerification, async (req, res) => {
        try {
            const services = await Service.find({ businessId: req.user.businessId, isDeleted: false })
                .populate('articleId')
                .populate('washingMethodId');
            res.json(services);
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Master Data Routes
    app.get('/api/master/articles', async (req, res) => {
        try {
            const articles = await Article.find().sort({ name: 1 });
            res.json(articles);
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    app.get('/api/master/washing-methods', async (req, res) => {
        try {
            const methods = await WashingMethod.find().sort({ name: 1 });
            res.json(methods);
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Create Order (Owner or Staff)
    app.post('/api/orders', sessionVerification, async (req, res) => {
        const { customerName, customerPhone, items, isPaid, photos, notes, dueDate, extraCharge, extraChargeReason } = req.body;
        const businessId = req.user.businessId;
        const staffId = req.user.id;
        try {
            if (photos && Array.isArray(photos) && photos.length > 5) {
                return res.status(400).json({ message: 'A maximum of 5 photos are allowed per order.' });
            }
            let totalAmount = 0;
            const orderItems = [];
            for (const item of items) {
                const service = await Service.findOne({ _id: item.serviceId, isDeleted: false });
                if (service) {
                    const pricingType = item.pricingType || 'unit';
                    const price = pricingType === 'kg' ? service.perKg : service.perUnit;
                    orderItems.push({
                        serviceId: service._id,
                        name: service.name,
                        price: price,
                        quantity: item.quantity,
                        pricingType: pricingType
                    });
                    totalAmount += price * item.quantity;
                }
            }
            totalAmount += (Number(extraCharge) || 0);
            const orderNumber = `ORD-${DateTime.now().toUTC().toMillis()}-${Math.floor(Math.random() * 1000)}`;
            const defaultStatus = await AllStatus.findOne({ status_id: SCHEMA_CONSTANTS.STATUSES.CREATED });
            if (!defaultStatus)
                throw new Error('Default order status not found');
            const order = await Order.create({
                orderNumber,
                customerName,
                customerPhone,
                businessId,
                staffId,
                services: orderItems,
                totalAmount,
                extraCharge: Number(extraCharge) || 0,
                extraChargeReason: extraChargeReason || '',
                isPaid,
                dueDate,
                notes,
                photos: photos || [],
                statusId: defaultStatus.status_id,
                updatedBy: req.user.id
            });
            res.status(201).json(order);
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Get Orders with filtering and searching
    app.get('/api/orders', sessionVerification, async (req, res) => {
        try {
            const { statusId, startDate, endDate, serviceId, search } = req.query;
            const matchCriteria = {
                businessId: new mongoose.Types.ObjectId(req.user.businessId)
            };
            // Filter by Status
            if (statusId) {
                if (statusId === 'paid') {
                    matchCriteria.isPaid = true;
                }
                else {
                    matchCriteria.statusId = Number(statusId);
                }
            }
            // Filter by Date Range
            if (startDate || endDate) {
                matchCriteria.createdAt = {};
                if (startDate)
                    matchCriteria.createdAt.$gte = startDate;
                if (endDate)
                    matchCriteria.createdAt.$lte = `${endDate}T23:59:59.999Z`;
            }
            // Filter by Service or Washing Method
            if (serviceId) {
                matchCriteria['services.serviceId'] = new mongoose.Types.ObjectId(serviceId);
            }
            if (req.query.washingMethodId) {
                // This would require checking the service's washingMethodId
                // In aggregation, we can use $lookup for services but it gets complex
                // For now, let's just stick to serviceId as it's what we have in frontend list
            }
            // Search by Customer Name, Order Number, or Phone
            if (search) {
                matchCriteria.$or = [
                    { customerName: { $regex: search, $options: 'i' } },
                    { orderNumber: { $regex: search, $options: 'i' } },
                    { customerPhone: { $regex: search, $options: 'i' } }
                ];
            }
            const orders = await Order.aggregate([
                { $match: matchCriteria },
                {
                    $lookup: {
                        from: "allstatuses",
                        localField: "statusId",
                        foreignField: "status_id",
                        as: "statusId"
                    }
                },
                {
                    $unwind: {
                        path: "$statusId",
                        preserveNullAndEmptyArrays: true
                    }
                },
                { $sort: { createdAt: -1 } }
            ]);
            res.json(orders);
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Get Onboarding Status
    app.get('/api/business/onboarding-status', sessionVerification, async (req, res) => {
        try {
            const businessId = req.user.businessId;
            const [serviceCount, staffCount] = await Promise.all([
                Service.countDocuments({ businessId, isDeleted: false }),
                User.countDocuments({ businessId, roleId: SCHEMA_CONSTANTS.ROLES.STAFF })
            ]);
            res.json({
                hasServices: serviceCount > 0,
                hasStaff: staffCount > 0,
                isNew: serviceCount === 0 || staffCount === 0
            });
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Update Order Status
    app.put('/api/orders/:id/status', sessionVerification, async (req, res) => {
        const { statusName } = req.body;
        try {
            const order = await Order.findOne({ _id: req.params.id, businessId: req.user.businessId });
            if (!order)
                return res.status(404).json({ message: 'Order not found' });
            if (statusName == "paid") {
                order.isPaid = true;
            }
            else {
                const status = await AllStatus.findOne({ status_name: statusName });
                if (status) {
                    order.statusId = status.status_id;
                }
            }
            order.updatedBy = req.user.id;
            order.updatedAt = DateTime.now().toUTC().toISO();
            await order.save();
            res.json({ message: 'Order status updated successfully', order });
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Upload Photos
    app.post('/api/upload', sessionVerification, upload.array('photos', 5), (req, res) => {
        try {
            const files = req.files;
            const filenames = files.map(file => file.filename);
            res.json({ filenames });
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Helper to get image path (for documentation/reference)
    // Images are served at: /uploads/orders/business_${businessId}/${filename}
    // Get Logged-in User Profile
    app.get('/api/auth/getuserprofile', sessionVerification, async (req, res) => {
        try {
            const user = await User.findOne({ _id: req.user.id, statusId: 1 });
            res.json(user);
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
    // Logout
    app.post('/api/auth/logout', (req, res) => {
        req.session.destroy((err) => {
            if (err)
                return res.status(500).json({ message: 'Could not log out' });
            res.clearCookie('token');
            res.json({ message: 'Logged out successfully' });
        });
    });
    app.get("/check-status", async (req, res) => {
        try {
            console.log("Inside check");
            setTimeout(() => {
                fetch("https://apsara-backend-766y.onrender.com/check-status");
            }, 5 * 60 * 1000);
            res.json({ message: "Ok" });
        }
        catch (error) {
        }
    });
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}
startServer();
