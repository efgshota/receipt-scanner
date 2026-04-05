import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { recordCorrection } from "@/lib/classification/learned-rules";
import type { Bucket, TransactionStatus } from "@/lib/types";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const [existing] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, id));

  if (!existing) {
    return NextResponse.json(
      { error: "Transaction not found" },
      { status: 404 }
    );
  }

  // If bucket is being changed, record correction for learning
  if (body.bucket && existing.bucket && body.bucket !== existing.bucket) {
    await recordCorrection(
      id,
      existing.bucket as Bucket,
      body.bucket as Bucket,
      existing.vendor
    );
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (body.bucket) updateData.bucket = body.bucket;
  if (body.status) updateData.status = body.status as TransactionStatus;
  if (body.confidence !== undefined) updateData.confidence = body.confidence;
  if (body.classificationReason)
    updateData.classificationReason = body.classificationReason;

  const [updated] = await db
    .update(transactions)
    .set(updateData)
    .where(eq(transactions.id, id))
    .returning();

  return NextResponse.json({ transaction: updated });
}
