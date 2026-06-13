import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { recordCorrection } from "@/lib/classification/learned-rules";
import type { Bucket, TransactionStatus } from "@/lib/types";
import { isValidStatus, isLegalTransition, isLocked } from "@/lib/status-transitions";

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

  const existingStatus = existing.status as TransactionStatus;

  // ステータス遷移の検証（不正な遷移＝未承認→提出済 などを防止）
  if (body.status !== undefined) {
    if (!isValidStatus(body.status)) {
      return NextResponse.json({ error: "status が不正です" }, { status: 400 });
    }
    if (!isLegalTransition(existingStatus, body.status)) {
      return NextResponse.json(
        {
          error: `不正な遷移: ${existingStatus} → ${body.status} は許可されていません`,
        },
        { status: 400 }
      );
    }
  }

  // 提出済/添付済はロック: 内容編集を禁止（差戻し＝approvedへ戻す場合のみ許可）
  if (isLocked(existingStatus)) {
    const editingFields =
      body.bucket !== undefined ||
      body.amount !== undefined ||
      body.vendor !== undefined ||
      body.date !== undefined ||
      body.description !== undefined;
    const isReverting = body.status === "approved";
    if (editingFields && !isReverting) {
      return NextResponse.json(
        { error: "提出済の取引はロックされています。先に差戻ししてください。" },
        { status: 409 }
      );
    }
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
  if (body.status) {
    updateData.status = body.status as TransactionStatus;
    // 提出済/添付済になったら提出日時を記録、戻したらクリア
    if (body.status === "submitted" || body.status === "attached") {
      updateData.submittedAt = existing.submittedAt ?? new Date();
    } else {
      updateData.submittedAt = null;
    }
  }
  if (body.confidence !== undefined) updateData.confidence = body.confidence;
  if (body.classificationReason)
    updateData.classificationReason = body.classificationReason;
  if (body.amount !== undefined) updateData.amount = body.amount;
  if (body.vendor) updateData.vendor = body.vendor;
  if (body.date !== undefined) updateData.date = body.date || null;
  if (body.description !== undefined) updateData.description = body.description;

  const [updated] = await db
    .update(transactions)
    .set(updateData)
    .where(eq(transactions.id, id))
    .returning();

  return NextResponse.json({ transaction: updated });
}
