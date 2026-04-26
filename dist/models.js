import mongoose from 'mongoose';
import { DateTime } from 'luxon';
export const getUTCNow = () => DateTime.now().toUTC().toISO();
export const getUTCNowAsDate = () => DateTime.now().toUTC().toJSDate();
// Role Master Collection
const roleSchema = new mongoose.Schema({
    role_id: { type: Number, required: true, unique: true },
    role_name: { type: String, required: true },
    createdAt: { type: String, default: getUTCNow },
    updatedAt: { type: String, default: getUTCNow },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});
export const Role = mongoose.model('Role', roleSchema);
// All Status Master Collection
const allStatusSchema = new mongoose.Schema({
    status_id: { type: Number, required: true, unique: true },
    status_name: { type: String, required: true },
    createdAt: { type: String, default: getUTCNow },
    updatedAt: { type: String, default: getUTCNow },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});
export const AllStatus = mongoose.model('AllStatus', allStatusSchema);
// Business Schema
const businessSchema = new mongoose.Schema({
    name: { type: String, required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    address: String,
    pincode: String,
    state: String,
    phone: String,
    statusId: { type: Number, required: true },
    createdAt: { type: String, default: getUTCNow },
    updatedAt: { type: String, default: getUTCNow },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});
export const Business = mongoose.model('Business', businessSchema);
// User Schema (Owner, Staff, Admin)
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // For password login
    roleId: { type: Number, required: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business' },
    statusId: { type: Number, required: true },
    isVerified: { type: Boolean, default: false },
    createdAt: { type: String, default: getUTCNow },
    updatedAt: { type: String, default: getUTCNow },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});
export const User = mongoose.model('User', userSchema);
// Archived User Schema for deleted staff
const archivedUserSchema = new mongoose.Schema({
    originalId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: String,
    phone: String,
    roleId: Number,
    businessId: mongoose.Schema.Types.ObjectId,
    statusId: Number,
    oldDetails: mongoose.Schema.Types.Mixed,
    archivedAt: { type: String, default: getUTCNow },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});
export const ArchivedUser = mongoose.model('ArchivedUser', archivedUserSchema);
// Service Schema
const serviceSchema = new mongoose.Schema({
    name: { type: String, required: true },
    perUnit: { type: Number, default: 0 },
    perKg: { type: Number, default: 0 },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
    washingMethodId: { type: mongoose.Schema.Types.ObjectId, ref: 'WashingMethod' },
    description: String,
    isDeleted: { type: Boolean, default: false },
    createdAt: { type: String, default: getUTCNow },
    updatedAt: { type: String, default: getUTCNow },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});
export const Service = mongoose.model('Service', serviceSchema);
// Order Schema
const orderSchema = new mongoose.Schema({
    orderNumber: { type: String, unique: true, required: true },
    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    services: [{
            serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
            name: String,
            price: Number,
            quantity: { type: Number, default: 1 },
            pricingType: { type: String, enum: ['unit', 'kg'], default: 'unit' }
        }],
    extraCharge: { type: Number, default: 0 },
    extraChargeReason: { type: String, default: '' },
    totalAmount: { type: Number, required: true },
    isPaid: { type: Boolean, default: false },
    photos: [{ type: String }], // Array of photo URLs
    statusId: { type: Number, required: true },
    completedAt: { type: String },
    notes: { type: String },
    dueDate: { type: String },
    createdAt: { type: String, default: getUTCNow },
    updatedAt: { type: String, default: getUTCNow },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
    toJSON: {
        virtuals: true,
        transform: (doc, ret) => {
            if (ret.photos && Array.isArray(ret.photos)) {
                const businessId = ret.businessId;
                // The host/baseUrl should be handled by the frontend, 
                // but we can provide the relative path for convenience
                ret.photoPaths = ret.photos.map((filename) => `/uploads/orders/business_${businessId}/${filename}`);
            }
            return ret;
        }
    }
});
export const Order = mongoose.model('Order', orderSchema);
// OTP Schema (Temporary for verification)
const otpSchema = new mongoose.Schema({
    phone: { type: String, required: true },
    otp: { type: String, required: true },
    createdAt: { type: Date, default: getUTCNowAsDate, expires: 600 } // Expires in 10 mins
});
export const OTP = mongoose.model('OTP', otpSchema);
// Article Master Collection
const articleSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    createdAt: { type: String, default: getUTCNow },
    updatedAt: { type: String, default: getUTCNow },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});
export const Article = mongoose.model('Article', articleSchema);
// Washing Method Master Collection
const washingMethodSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    createdAt: { type: String, default: getUTCNow },
    updatedAt: { type: String, default: getUTCNow },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});
export const WashingMethod = mongoose.model('WashingMethod', washingMethodSchema);
