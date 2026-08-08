import bcrypt from 'bcryptjs';
import { Article, WashingMethod, AdminUser } from '../models.js';
const ARTICLES = [
    'Blouse', 'Tshirt', 'Shirt', 'Top', 'Trousers', 'Jeans', 'Dupatta',
    'Kurta', 'Kurti', 'Anarkali Kurti', 'Salwar Suit', 'Churidar Suit',
    'Anarkali Suit', 'Formal Skirt', 'Short Skirt', 'Western Skirt',
    'Ethnic Skirt', 'Long Skirt', 'Dress', 'Jumpsuit', 'Gown', 'Lahenga',
    'Waist Coat', 'Sleevless Jacket', 'Hoodie', 'Sweater', 'Jacket',
    'Blazer', 'Coat', '2 Pcs Suit', '3 Pcs Suit', 'Sherwani', 'Dhoti',
    'Saree', 'Saree (Light Stone Work)', 'Saree (Heavy Stone Work)', 'Shawl',
    'Bedsheets', 'Blankets', 'Quilts', 'Curtains', 'Baby Clothes',
    'Soft Toys', 'Pilling', 'Other',
];
const WASHING_METHODS = [
    'Steam Wash', 'Wet Wash', 'Petrol Wash', 'Ironing Only', 'Steam Iron',
    'Machine Wash', 'Hand wash', 'Dry Clean', 'Machine Wash (Gentle)',
    'Hand Wash (Gentle)', 'Premium Dry Wash', 'Dettol Wash', 'Other',
];
const ADMIN_USERS = [
    { name: 'Tarun', username: 'tarun', plainPassword: 'Tarun@123' },
    { name: 'Anshul', username: 'anshul', plainPassword: 'Anshul@123' },
];
export async function seedDatabase() {
    // One bulkWrite per collection instead of an awaited upsert per row. This ran 58 sequential
    // round trips on every single boot — trivial against a local database, a visible chunk of
    // startup time against a hosted one, and repeated on every restart and every deploy.
    await Promise.all([
        Article.deleteMany({ name: { $nin: ARTICLES } }),
        WashingMethod.deleteMany({ name: { $nin: WASHING_METHODS } }),
    ]);
    await Promise.all([
        Article.bulkWrite(ARTICLES.map((name) => ({ updateOne: { filter: { name }, update: { $setOnInsert: { name } }, upsert: true } }))),
        WashingMethod.bulkWrite(WASHING_METHODS.map((name) => ({ updateOne: { filter: { name }, update: { $setOnInsert: { name } }, upsert: true } }))),
    ]);
    // Admin users keep their read-then-write shape: the password has to be hashed only when the
    // row is genuinely absent, and bcrypt on every boot for accounts that already exist would
    // cost far more than the two queries saved.
    const existingAdmins = await AdminUser.find({ username: { $in: ADMIN_USERS.map((a) => a.username) } })
        .select('username')
        .lean();
    const haveAdmin = new Set(existingAdmins.map((a) => a.username));
    for (const admin of ADMIN_USERS) {
        if (haveAdmin.has(admin.username))
            continue;
        const password = await bcrypt.hash(admin.plainPassword, 10);
        await AdminUser.create({ name: admin.name, username: admin.username, password });
    }
    console.log('Database seeded');
}
