import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { extractReceiptData } from "@/lib/ocr/receipt-ocr";
import { classify } from "@/lib/classification/engine";
import fs from "fs";
import path from "path";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Upload: Vercel Blob (production) or local file (development)
    let imageUrl: string;
    const arrayBuffer = await file.arrayBuffer();

    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const blob = await put(`receipts/${Date.now()}-${file.name}`, file, {
        access: "public",
      });
      imageUrl = blob.url;
    } else {
      const filename = `${Date.now()}-${file.name}`;
      const uploadsDir = path.join(process.cwd(), "public/uploads");
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(arrayBuffer));
      imageUrl = `/uploads/${filename}`;
    }

    // Convert to base64 for OCR
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    const mediaType = file.type as "image/jpeg" | "image/png" | "image/webp";

    // Extract data via OCR
    const ocrResult = await extractReceiptData(base64, mediaType);

    // Date sanity check: receipts older than 2025 are suspicious (likely OCR error)
    const dateYear = ocrResult.date ? parseInt(ocrResult.date.slice(0, 4)) : 0;
    const suspiciousDate = dateYear > 0 && dateYear < 2025;

    // Classify the transaction
    const classification = await classify({
      vendor: ocrResult.vendor,
      amount: ocrResult.amount,
      date: ocrResult.date,
      description: ocrResult.description,
    });

    // Store in database
    const [inserted] = await db
      .insert(transactions)
      .values({
        source: "photo",
        vendor: ocrResult.vendor || "Unknown",
        amount: ocrResult.amount ?? 0,
        date: ocrResult.date || null,
        description: ocrResult.description,
        invoiceNumber: ocrResult.invoiceNumber,
        receiptImageUrl: imageUrl,
        ocrRaw: ocrResult.raw,
        bucket: classification.bucket,
        confidence: classification.confidence,
        classificationReason: suspiciousDate
          ? `${classification.reason} | ⚠ 日付要確認 (${ocrResult.date})`
          : classification.reason,
        status:
          suspiciousDate || classification.confidence < 0.85
            ? "pending"
            : "classified",
      })
      .returning();

    return NextResponse.json({
      transaction: inserted,
      ocr: ocrResult,
      classification,
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: "Failed to process receipt" },
      { status: 500 }
    );
  }
}
