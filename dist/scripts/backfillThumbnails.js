import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { OrderImage } from '../models.js';
/**
 * Generates the ~400px WebP derivative for order images uploaded before the resize pipeline
 * existed, and records it on `thumb_url`.
 *
 * Optional. The frontend falls back to the original whenever `thumb_url` is empty, so old
 * images render correctly with or without this — running it just means the order card stops
 * pulling a multi-megabyte original to fill a 96px tile.
 *
 *   npx tsx src/scripts/backfillThumbnails.ts            (dry run)
 *   npx tsx src/scripts/backfillThumbnails.ts --apply
 *
 * Safe to interrupt and re-run: it only considers rows with no thumb_url, and skips any whose
 * derivative is already on disk.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
const APPLY = process.argv.includes('--apply');
async function main() {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/apsaraclean';
    await mongoose.connect(uri, { family: 4 });
    console.log(`Connected to ${uri}`);
    console.log(APPLY ? '\n=== APPLYING ===\n' : '\n=== DRY RUN (pass --apply to write) ===\n');
    const pending = await OrderImage.find({ $or: [{ thumb_url: '' }, { thumb_url: { $exists: false } }] }).lean();
    console.log(`${pending.length} image(s) without a thumbnail.`);
    let generated = 0;
    let missing = 0;
    let failed = 0;
    for (const img of pending) {
        // image_url is `/uploads/orders/business_<id>/<filename>` — resolve it back to disk the
        // same way purge.ts does.
        const relative = img.image_url.replace(/^\/uploads\//, '');
        const sourcePath = path.join(uploadsDir, relative);
        if (!fs.existsSync(sourcePath)) {
            missing += 1;
            continue;
        }
        const dir = path.dirname(sourcePath);
        const thumbName = `thumb-${path.parse(sourcePath).name}.webp`;
        const thumbUrl = `${path.dirname(img.image_url)}/${thumbName}`;
        if (!APPLY) {
            generated += 1;
            continue;
        }
        try {
            if (!fs.existsSync(path.join(dir, thumbName))) {
                await sharp(sourcePath)
                    .rotate()
                    .resize({ width: 400, withoutEnlargement: true })
                    .webp({ quality: 80 })
                    .toFile(path.join(dir, thumbName));
            }
            await OrderImage.updateOne({ _id: img._id }, { $set: { thumb_url: thumbUrl } });
            generated += 1;
        }
        catch (err) {
            console.error(`  failed for ${img.image_url}: ${err.message}`);
            failed += 1;
        }
    }
    console.log(`\n${APPLY ? 'Generated' : 'Would generate'}: ${generated}`);
    console.log(`Source file missing on disk (skipped): ${missing}`);
    if (failed)
        console.log(`Failed: ${failed}`);
    if (!APPLY)
        console.log('\nNothing was written. Re-run with --apply.');
    await mongoose.disconnect();
}
main().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
