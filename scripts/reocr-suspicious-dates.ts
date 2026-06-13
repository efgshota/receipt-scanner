/**
 * 2025年以前と判定された取引を再OCRするスクリプト。
 * OCRの日付誤読を厳重チェックして修正する。
 */

import fs from "fs";
import path from "path";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and, lt, isNotNull } from "drizzle-orm";
import { transactions } from "../src/lib/db/schema";
import { extractReceiptData } from "../src/lib/ocr/receipt-ocr";

const sql = neon(process.env.POSTGRES_URL!);
const db = drizzle(sql);

async function main() {
  // Get all transactions before 2025-01-01 with receipt images
  const suspicious = await db
    .select()
    .from(transactions)
    .where(
      and(
        lt(transactions.date, "2025-01-01"),
        isNotNull(transactions.receiptImageUrl)
      )
    );

  console.log(`Found ${suspicious.length} transactions with dates before 2025`);
  console.log();

  let fixed = 0;
  let unchanged = 0;
  let errors = 0;

  for (const tx of suspicious) {
    if (!tx.receiptImageUrl) continue;

    const imagePath = path.join(process.cwd(), "public", tx.receiptImageUrl);
    if (!fs.existsSync(imagePath)) {
      console.log(`  ⚠ Image not found: ${tx.receiptImageUrl}`);
      errors++;
      continue;
    }

    console.log(`Processing: ${tx.date} ${tx.vendor} ¥${tx.amount} [${tx.id.slice(0, 8)}]`);

    try {
      const fileBuffer = fs.readFileSync(imagePath);
      const base64 = fileBuffer.toString("base64");
      const ext = path.extname(imagePath).slice(1).toLowerCase();
      const mediaType = (ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg") as
        | "image/jpeg"
        | "image/png"
        | "image/webp";

      const ocr = await extractReceiptData(base64, mediaType);
      const newDateYear = ocr.date ? parseInt(ocr.date.slice(0, 4)) : 0;

      console.log(`  OCR: ${ocr.date} ${ocr.vendor} ¥${ocr.amount}`);
      if ((ocr.raw as Record<string, unknown>)?.dateReasoning) {
        console.log(`  reasoning: ${(ocr.raw as Record<string, unknown>).dateReasoning}`);
      }

      // Determine if date changed
      if (ocr.date && ocr.date !== tx.date) {
        const stillSuspicious = newDateYear > 0 && newDateYear < 2025;
        await db
          .update(transactions)
          .set({
            date: ocr.date,
            vendor: ocr.vendor || tx.vendor,
            amount: ocr.amount || tx.amount,
            description: ocr.description || tx.description,
            ocrRaw: ocr.raw,
            classificationReason: stillSuspicious
              ? `re-ocr | ⚠ 日付要確認 (${ocr.date})`
              : "re-ocr",
            status: stillSuspicious ? "pending" : tx.status,
            updatedAt: new Date(),
          })
          .where(eq(transactions.id, tx.id));
        console.log(`  ✓ Updated: ${tx.date} → ${ocr.date}`);
        fixed++;
      } else {
        console.log(`  = Unchanged`);
        unchanged++;
      }

      // Rate limit
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.log(`  ✗ Error: ${e}`);
      errors++;
    }
  }

  console.log();
  console.log(`Done: ${fixed} fixed, ${unchanged} unchanged, ${errors} errors`);
}

main().catch(console.error);
