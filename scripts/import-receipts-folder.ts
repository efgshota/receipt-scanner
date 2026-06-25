/**
 * receipts/{nagi,stadiums,family}/ の画像をOCRしてDBに取り込む。
 * フォルダ＝バケツが確定しているので分類不要。
 *
 * デフォルトはドライラン（OCR＋重複判定のみ、書込なし）。
 * OCR結果は scripts/.receipts-ocr-cache.json にキャッシュ（再実行/適用時に再OCRしない）。
 *
 * 使い方:
 *   set -a && . ./.env && set +a && tsx scripts/import-receipts-folder.ts          # ドライラン
 *   set -a && . ./.env && set +a && tsx scripts/import-receipts-folder.ts --apply  # DB投入＋画像をpublic/uploadsへ＋done/へ移動
 */
import fs from "fs";
import path from "path";
import { neon } from "@neondatabase/serverless";
import { extractReceiptData } from "../src/lib/ocr/receipt-ocr";
import type { OcrResult } from "../src/lib/types";

const APPLY = process.argv.includes("--apply");
const sql = neon(process.env.POSTGRES_URL!);

const BUCKETS = ["nagi", "stadiums", "family"] as const;
const ROOT = process.cwd();
const RECEIPTS_DIR = path.join(ROOT, "receipts");
const UPLOADS_DIR = path.join(ROOT, "public", "uploads");
const DONE_DIR = path.join(ROOT, "done");
const CACHE_PATH = path.join(ROOT, "scripts", ".receipts-ocr-cache.json");

const IMG_RE = /\.(jpe?g|png|webp)$/i;
function mediaTypeOf(p: string): "image/jpeg" | "image/png" | "image/webp" {
  const e = path.extname(p).slice(1).toLowerCase();
  return e === "png" ? "image/png" : e === "webp" ? "image/webp" : "image/jpeg";
}

type Cache = Record<string, { mtimeMs: number; ocr: OcrResult }>;
function loadCache(): Cache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}
function saveCache(c: Cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2));
}

async function ocrCached(absPath: string, relKey: string, cache: Cache): Promise<OcrResult> {
  const mtimeMs = fs.statSync(absPath).mtimeMs;
  const hit = cache[relKey];
  if (hit && hit.mtimeMs === mtimeMs) return hit.ocr;
  const base64 = fs.readFileSync(absPath).toString("base64");
  const ocr = await extractReceiptData(base64, mediaTypeOf(absPath));
  cache[relKey] = { mtimeMs, ocr };
  saveCache(cache);
  await new Promise((r) => setTimeout(r, 1200)); // rate limit
  return ocr;
}

// 既存DBとの重複判定。
// バケツ+金額+日付の「完全一致」のみを重複とみなす。
// （同額・同店でも日付が違えば別取引＝タクシー/給油などの誤検出を防ぐ）
async function findDuplicate(
  bucket: string,
  amount: number,
  date: string
): Promise<string | null> {
  if (amount > 0 && date) {
    const exact = await sql`
      SELECT id FROM transactions
      WHERE bucket = ${bucket} AND amount = ${amount} AND date = ${date} LIMIT 1`;
    if (exact.length) return "完全一致(金額+日付)";
  }
  return null;
}

async function main() {
  console.log(`${APPLY ? "[APPLY]" : "[DRY-RUN]"} receipts/ フォルダ取込\n`);
  const cache = loadCache();

  let total = 0,
    dups = 0,
    fresh = 0,
    inserted = 0,
    errors = 0;

  for (const bucket of BUCKETS) {
    const dir = path.join(RECEIPTS_DIR, bucket);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => IMG_RE.test(f));
    if (!files.length) continue;
    console.log(`\n=== ${bucket} (${files.length}件) ===`);

    for (const file of files) {
      total++;
      const abs = path.join(dir, file);
      const relKey = `${bucket}/${file}`;
      try {
        const ocr = await ocrCached(abs, relKey, cache);
        const dup = await findDuplicate(bucket, ocr.amount, ocr.date);
        const flag = dup ? `⚠ 重複候補: ${dup}` : "✓ 新規";
        if (dup) dups++;
        else fresh++;
        console.log(
          `  ${flag.padEnd(22)} ${(ocr.date || "日付なし").padEnd(11)} ¥${String(ocr.amount).padStart(7)}  ${ocr.vendor}  [${file}]`
        );

        if (APPLY && !dup) {
          // 画像を public/uploads にコピー
          if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
          const destName = `${Date.now()}-folder_${file}`;
          fs.copyFileSync(abs, path.join(UPLOADS_DIR, destName));
          const imageUrl = `/uploads/${destName}`;

          const dateYear = ocr.date ? parseInt(ocr.date.slice(0, 4)) : 0;
          const suspicious = dateYear > 0 && dateYear < 2025;
          const status = !ocr.date || ocr.amount <= 0 || suspicious ? "pending" : "classified";

          await sql`
            INSERT INTO transactions
              (source, vendor, amount, date, description, invoice_number, receipt_image_url,
               ocr_raw, bucket, confidence, classification_reason, status)
            VALUES
              ('photo', ${ocr.vendor || "Unknown"}, ${ocr.amount ?? 0}, ${ocr.date || null},
               ${ocr.description || ""}, ${ocr.invoiceNumber}, ${imageUrl},
               ${JSON.stringify(ocr.raw)}, ${bucket}, 1.0, 'folder-import',
               ${status})`;
          inserted++;

          // 元画像を done/{bucket}/ へ移動
          const doneBucket = path.join(DONE_DIR, bucket);
          if (!fs.existsSync(doneBucket)) fs.mkdirSync(doneBucket, { recursive: true });
          fs.renameSync(abs, path.join(doneBucket, file));
        }
      } catch (e) {
        errors++;
        console.log(`  ✗ error [${file}]: ${e}`);
      }
    }
  }

  console.log(`\n――――――――――――`);
  console.log(`合計 ${total} / 新規 ${fresh} / 重複候補 ${dups} / エラー ${errors}`);
  if (APPLY) console.log(`投入 ${inserted}件（重複候補はスキップ）`);
  else if (fresh > 0) console.log(`→ 投入するには: set -a && . ./.env && set +a && tsx scripts/import-receipts-folder.ts --apply`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
