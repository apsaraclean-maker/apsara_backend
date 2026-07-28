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
  // Articles
  await Article.deleteMany({ name: { $nin: ARTICLES } });
  for (const name of ARTICLES) {
    await Article.findOneAndUpdate({ name }, { name }, { upsert: true });
  }

  // Washing methods
  await WashingMethod.deleteMany({ name: { $nin: WASHING_METHODS } });
  for (const name of WASHING_METHODS) {
    await WashingMethod.findOneAndUpdate({ name }, { name }, { upsert: true });
  }

  // Admin users
  for (const admin of ADMIN_USERS) {
    const existing = await AdminUser.findOne({ username: admin.username });
    if (!existing) {
      const password = await bcrypt.hash(admin.plainPassword, 10);
      await AdminUser.create({ name: admin.name, username: admin.username, password });
    }
  }

  console.log('Database seeded');
}
