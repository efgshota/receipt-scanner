/**
 * 指定した取引を再OCRして検証するスクリプト。
 * デフォルトはドライラン（DBに書き込まない）。--apply で適用。
 *
 * 対象: 日付不良(null/2025未満) + 高額×低確信度（OCR誤読の疑い）
 *
 * 使い方:
 *   tsx scripts/reocr-targeted.ts            # ドライラン（比較表示のみ）
 *   tsx scripts/reocr-targeted.ts --apply    # DBに適用
 */
import fs from "fs";
import path from "path";

const envContent = fs.readFileSync(path.join(process.cwd(), ".env"), "utf-8");
for (const line of envContent.split("\n")) {
  const [k, ...v] = line.split("=");
  if (k && v.length) process.env[k.trim()] = v.join("=").trim();
}

import { neon } from "@neondatabase/serverless";
import { extractReceiptData } from "../src/lib/ocr/receipt-ocr";

const APPLY = process.argv.includes("--apply");
const sql = neon(process.env.POSTGRES_URL!);

async function main() {
  const rows = await sql`
    SELECT id, date::text AS d, vendor, amount, bucket, confidence, status, receipt_image_url AS url
    FROM transactions
    WHERE (date IS NULL OR date < '2025-01-01')
       OR (amount >= 40000 AND (confidence IS NULL OR confidence < 0.85))
    ORDER BY amount DESC`;

  console.log(`${APPLY ? "[APPLY]" : "[DRY-RUN]"} 対象 ${rows.length}件\n`);

  let changed = 0,
    same = 0,
    errors = 0;

  for (const r of rows) {
    const url = r.url as string | null;
    if (!url) {
      console.log(`  ⚠ no-url skip: ${r.vendor}`);
      errors++;
      continue;
    }
    const imgPath = path.join(process.cwd(), "public", url);
    if (!fs.existsSync(imgPath)) {
      console.log(`  ⚠ img-missing skip: ${url}`);
      errors++;
      continue;
    }

    try {
      const buf = fs.readFileSync(imgPath);
      const base64 = buf.toString("base64");
      const ext = path.extname(imgPath).slice(1).toLowerCase();
      const mediaType = (ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : "image/jpeg") as "image/jpeg" | "image/png" | "image/webp";

      const ocr = await extractReceiptData(base64, mediaType);

      const dateChg = (ocr.date || null) !== (r.d || null);
      const amtChg = ocr.amount !== r.amount;
      const venChg = ocr.vendor && ocr.vendor !== r.vendor;
      const anyChg = dateChg || amtChg || venChg;

      console.log(`\n[${r.id.slice(0, 8)}] ${anyChg ? "★CHANGED" : "=same"}`);
      console.log(`  旧: ${r.d || "(null)"} | ¥${r.amount} | ${r.vendor}`);
      console.log(`  新: ${ocr.date || "(null)"} | ¥${ocr.amount} | ${ocr.vendor}`);
      const raw = ocr.raw as Record<string, unknown>;
      if (raw?.dateConfidence) console.log(`  dateConf: ${raw.dateConfidence} | ${raw.dateReasoning ?? ""}`);

      if (anyChg) {
        changed++;
        if (APPLY) {
          const newDate = ocr.date || null;
          const newYear = ocr.date ? parseInt(ocr.date.slice(0, 4)) : 0;
          const stillBad = (newYear > 0 && newYear < 2025) || !newDate || ocr.amount <= 0;
          await sql`
            UPDATE transactions
            SET date = ${newDate},
                vendor = ${ocr.vendor || r.vendor},
                amount = ${ocr.amount || r.amount},
                description = ${ocr.description || ""},
                invoice_number = COALESCE(${ocr.invoiceNumber}, invoice_number),
                ocr_raw = ${JSON.stringify(ocr.raw)},
                classification_reason = ${stillBad ? "re-ocr | ⚠ 要確認" : "re-ocr"},
                status = ${stillBad ? "pending" : r.status},
                updated_at = now()
            WHERE id = ${r.id}`;
          console.log(`  ✓ 適用${stillBad ? "（まだ要確認）" : ""}`);
        }
      } else {
        same++;
      }

      await new Promise((res) => setTimeout(res, 1500)); // rate limit
    } catch (e) {
      console.log(`  ✗ error: ${e}`);
      errors++;
    }
  }

  console.log(`\n完了: 変化 ${changed} / 同じ ${same} / エラー ${errors}`);
  if (!APPLY && changed > 0) console.log(`→ 適用するには: tsx scripts/reocr-targeted.ts --apply`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
