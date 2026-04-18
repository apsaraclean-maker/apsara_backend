import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import cookieParser from 'cookie-parser';
import { Business, User, Service, Order, OTP, Role, AllStatus, Article, Material, WashingMethod, getUTCNow } from './models.js';
import { generateToken, authenticateToken, authorizeRoles, sessionVerification } from './auth.js';
import { sendWhatsAppOTP } from './whatsappService.js';
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
  const PORT = process.env.PORT

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
      { status_id: SCHEMA_CONSTANTS.STATUSES.ACTIVE, status_name: 'active' },
      { status_id: SCHEMA_CONSTANTS.STATUSES.INACTIVE, status_name: 'inactive' },
      { status_id: SCHEMA_CONSTANTS.STATUSES.BLOCKED, status_name: 'blocked' },
      { status_id: SCHEMA_CONSTANTS.STATUSES.CREATED, status_name: 'created' },
      { status_id: SCHEMA_CONSTANTS.STATUSES.IN_PROGRESS, status_name: 'in progress' },
      { status_id: SCHEMA_CONSTANTS.STATUSES.COMPLETED, status_name: 'completed' }
    ];
    for (const s of statuses) {
      await AllStatus.findOneAndUpdate({ status_id: s.status_id }, s, { upsert: true });
    }

    const articles = ['Shirt', 'T-Shirt', 'Jeans', 'Saree', 'Suit', 'Blanket', 'Curtains'];
    for (const name of articles) {
      await Article.findOneAndUpdate({ name }, { name }, { upsert: true });
    }

    const materials = ['Cotton', 'Silk', 'Woolen', 'Synthetic', 'Denim', 'Linen'];
    for (const name of materials) {
      await Material.findOneAndUpdate({ name }, { name }, { upsert: true });
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
  } catch (err) {
    console.error('MongoDB connection error:', err);
    // In a real app, you might want to exit, but here we'll let it try to run
    // maybe Provide a mock/in-memory fallback if needed for the preview?
    // For now, assume user provides URI or local mongo is running.
  }

  app.set('trust proxy', 1);

  app.use(express.json());
  app.use(cookieParser());

  // Static files for uploads
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
  }
  app.use('/uploads', express.static(uploadsDir));

  // Multer configuration
  const storage = multer.diskStorage({
    destination: (req: any, file, cb) => {
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


  const allowedOrigins: string[] = [
  "https://funny-llama-333beb.netlify.app",
  "http://localhost:3000"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true"); // ✅ required for cookies/auth
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

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
      secure: process.env.NODE_ENV === 'production'
    }
  }));


  app.post('/api/auth/register-business', async (req, res) => {
    const { businessName, ownerName, phone, address, pincode, state } = req.body;
    
    try {
      const existingUser = await User.findOne({ phone });
      if (existingUser) return res.status(400).json({ message: 'Phone already registered' });

      // Generate OTP
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      await OTP.create({ phone, otp: otpCode });

      // Send via real WhatsApp Service
      await sendWhatsAppOTP(phone, otpCode);

      // Create owner (unverified)
      const ownerRole = await Role.findOne({ role_id: SCHEMA_CONSTANTS.ROLES.OWNER });
      const activeStatus = await AllStatus.findOne({ status_id: SCHEMA_CONSTANTS.STATUSES.ACTIVE });
      if (!ownerRole) throw new Error('Owner role not found');
      if (!activeStatus) throw new Error('Active status not found');

      const user = await User.create({
        name: ownerName,
        phone,
        roleId: ownerRole.role_id,
        statusId: activeStatus.status_id,
        isVerified: false
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

      user.businessId = business._id as any;
      user.updatedBy = user._id;
      await user.save();

      res.status(201).json({ message: 'Registration initiated. Please verify OTP sent to WhatsApp.', phone });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Verify OTP
  app.post('/api/auth/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;
    
    try {
      const otpDoc = await OTP.findOne({ phone, otp });
      if (!otpDoc) return res.status(400).json({ message: 'Invalid or expired OTP' });

      const user = await User.findOne({ phone });
      if (!user) return res.status(404).json({ message: 'User not found' });

      user.isVerified = true;
      user.updatedAt = getUTCNow();
      user.updatedBy = user._id;
      await user.save();
      await OTP.deleteOne({ phone });

      const populatedUser = await User.findById(user._id);
      const token = generateToken({ 
        id: user._id, 
        role: (populatedUser?.roleId as any), 
        businessId: user.businessId 
      });
      
      // Set session
      (req.session as any).userId = user._id;

      res.cookie('token', token, { httpOnly: true });
      res.json({ message: 'User verified successfully', user, token });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Login (Request OTP)
  app.post('/api/auth/login', async (req, res) => {
    const { phone } = req.body;
    try {
      const user = await User.findOne({ phone });
      if (!user) return res.status(404).json({ message: 'Account not found' });

      // Generate OTP
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      await OTP.create({ phone, otp: otpCode });

      // Send via WhatsApp
      await sendWhatsAppOTP(phone, otpCode);

      res.json({ message: 'OTP sent to WhatsApp for login', phone });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Add Staff (Owner only)
  app.post('/api/business/staff', sessionVerification, authorizeRoles(2), async (req: any, res) => {
    const { name, phone } = req.body;
    const businessId = req.user.businessId;

    try {
      const staffRole = await Role.findOne({ role_id: SCHEMA_CONSTANTS.ROLES.STAFF });
      const activeStatus = await AllStatus.findOne({ status_id: SCHEMA_CONSTANTS.STATUSES.ACTIVE });
      if (!staffRole) throw new Error('Staff role not found');
      if (!activeStatus) throw new Error('Active status not found');

      const staff = await User.create({
        name,
        phone,
        roleId: staffRole.role_id,
        statusId: activeStatus.status_id,
        businessId,
        isVerified: true,
        updatedBy: req.user.id
      });
      res.status(201).json(staff);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Add Service (Owner only)
  app.post('/api/business/services', sessionVerification, async (req: any, res) => {
    const { name, price, description, articleId, materialId, washingMethodId } = req.body;
    const businessId = req.user.businessId;

    try {
      const service = await Service.create({ 
        name, 
        price, 
        description, 
        businessId,
        articleId,
        materialId,
        washingMethodId,
        updatedBy: req.user.id
      });
      res.status(201).json(service);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Get Services
  app.get('/api/business/services', sessionVerification, async (req: any, res) => {
    try {
      const services = await Service.find({ businessId: req.user.businessId })
        .populate('articleId')
        .populate('materialId')
        .populate('washingMethodId');
      res.json(services);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Master Data Routes
  app.get('/api/master/articles', async (req, res) => {
    try {
      const articles = await Article.find().sort({ name: 1 });
      res.json(articles);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/master/materials', async (req, res) => {
    try {
      const materials = await Material.find().sort({ name: 1 });
      res.json(materials);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/master/washing-methods', async (req, res) => {
    try {
      const methods = await WashingMethod.find().sort({ name: 1 });
      res.json(methods);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Create Order (Owner or Staff)
  app.post('/api/orders', sessionVerification, async (req: any, res) => {
    const { customerName, customerPhone, items, isPaid, photos } = req.body;
    const businessId = req.user.businessId;
    const staffId = req.user.id;

    try {
      if (photos && Array.isArray(photos) && photos.length > 5) {
        return res.status(400).json({ message: 'A maximum of 5 photos are allowed per order.' });
      }

      let totalAmount = 0;
      const orderItems = [];

      for (const item of items) {
        const service = await Service.findById(item.serviceId);
        if (service) {
          orderItems.push({
            serviceId: service._id,
            name: service.name,
            price: service.price,
            quantity: item.quantity
          });
          totalAmount += service.price * item.quantity;
        }
      }

      const orderNumber = `ORD-${DateTime.now().toUTC().toMillis()}-${Math.floor(Math.random() * 1000)}`;
      
      const defaultStatus = await AllStatus.findOne({ status_id: SCHEMA_CONSTANTS.STATUSES.CREATED });
      if (!defaultStatus) throw new Error('Default order status not found');

      const order = await Order.create({
        orderNumber,
        customerName,
        customerPhone,
        businessId,
        staffId,
        services: orderItems,
        totalAmount,
        isPaid,
        photos: photos || [],
        statusId: defaultStatus.status_id,
        updatedBy: req.user.id
      });

      res.status(201).json(order);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Get Orders
  app.get('/api/orders', sessionVerification, async (req: any, res) => {
    try {

      console.log(req.user);
      

      
      const orders = await Order.aggregate([
  {
    $match: {
      businessId:new mongoose.Types.ObjectId(req.user.businessId)
    }
  },
  {
    $lookup: {
      from: "allstatuses", // ⚠️ collection name (usually lowercase plural)
      localField: "statusId", // number in Order
      foreignField: "status_id", // number in AllStatus
      as: "statusId"
    }
  },
  {
    $unwind: {
      path: "$statusId",
      preserveNullAndEmptyArrays: true
    }
  },
  {
    $sort: { createdAt: -1 }
  }
]);
console.log(orders);

      res.json(orders);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Update Order Status
  app.put('/api/orders/:id/status', sessionVerification, async (req: any, res) => {
    const { statusName } = req.body;
    try {
      const order = await Order.findOne({ _id: req.params.id, businessId: req.user.businessId });
      if (!order) return res.status(404).json({ message: 'Order not found' });

      if(statusName=="paid")
      {

        order.isPaid=true

      }else{

        
        const status = await AllStatus.findOne({ status_name:statusName});
        
        if(status)
        { 
          order.statusId = status.status_id;
        }
        }
      order.updatedBy=req.user.id
      order.updatedAt = DateTime.now().toUTC().toISO();
      await order.save();
      
      res.json({ message: 'Order status updated successfully', order });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Upload Photos
  app.post('/api/upload', sessionVerification, upload.array('photos', 5), (req: any, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      const filenames = files.map(file => file.filename);
      res.json({ filenames });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Helper to get image path (for documentation/reference)
  // Images are served at: /uploads/orders/business_${businessId}/${filename}

  // Get Logged-in User Profile
  app.get('/api/auth/getuserprofile', sessionVerification, async (req: any, res) => {
    try {
      const user = await User.aggregate([
  {
    $match: {
      _id: new mongoose.Types.ObjectId(req.user.id)
    }
  },

  // BUSINESS
  {
    $lookup: {
      from: "businesses",
      localField: "businessId",
      foreignField: "_id",
      as: "businessId"
    }
  },
  {
    $unwind: {
      path: "$businessId",
      preserveNullAndEmptyArrays: true
    }
  },

  // ROLE
  {
    $lookup: {
      from: "roles",
      localField: "roleId",
      foreignField: "role_id",
      as: "roleId"
    }
  },
  {
    $unwind: {
      path: "$roleId",
      preserveNullAndEmptyArrays: true
    }
  },

  // STATUS
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
  }
]);
      res.json(user);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Logout
  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ message: 'Could not log out' });
      res.clearCookie('token');
      res.json({ message: 'Logged out successfully' });
    });
  });


  app.get("/check-status",async(req,res)=>{
  try {
    console.log("Inside check");
    
    setTimeout(()=>{
      fetch("https://apsara-backend-766y.onrender.com/check-status")
    },5*60*1000)
    res.json({message:"Ok"})
  } catch (error) {
    
  }
})

  



  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
