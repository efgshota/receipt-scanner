import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { extractReceiptData } from "@/lib/ocr/receipt-ocr";
import { classify } from "@/lib/classification/engine";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Upload to Vercel Blob
    const blob = await put(`receipts/${Date.now()}-${file.name}`, file, {
      access: "public",
    });

    // Convert to base64 for OCR
    const arrayBuffer = await file.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    const mediaType = file.type as "image/jpeg" | "image/png" | "image/webp";

    // Extract data via OCR
    const ocrResult = await extractReceiptData(base64, mediaType);

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
        vendor: ocrResult.vendor,
        amount: ocrResult.amount,
        date: ocrResult.date,
        description: ocrResult.description,
        invoiceNumber: ocrResult.invoiceNumber,
        receiptImageUrl: blob.url,
        ocrRaw: ocrResult.raw,
        bucket: classification.bucket,
        confidence: classification.confidence,
        classificationReason: classification.reason,
        status:
          classification.confidence >= 0.85 ? "classified" : "pending",
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
