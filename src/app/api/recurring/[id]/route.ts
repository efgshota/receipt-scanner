import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recurringRules } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const b = await request.json().catch(() => ({}));

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof b.name === "string" && b.name.trim()) set.name = b.name.trim();
  if (typeof b.vendorPattern === "string" && b.vendorPattern.trim())
    set.vendorPattern = b.vendorPattern.trim();
  if (Number.isInteger(b.expectedAmount) && b.expectedAmount > 0)
    set.expectedAmount = b.expectedAmount;
  if (typeof b.amountTolerance === "number")
    set.amountTolerance = b.amountTolerance;
  if (Number.isInteger(b.dayOfMonth))
    set.dayOfMonth = Math.min(28, Math.max(1, b.dayOfMonth));
  if (["nagi", "stadiums", "family"].includes(b.bucket)) set.bucket = b.bucket;
  if (typeof b.active === "boolean") set.active = b.active;
  if (typeof b.autoSubmit === "boolean") set.autoSubmit = b.autoSubmit;
  if (typeof b.notes === "string") set.notes = b.notes;

  const [rule] = await db
    .update(recurringRules)
    .set(set)
    .where(eq(recurringRules.id, id))
    .returning();
  if (!rule) {
    return NextResponse.json({ error: "ルールが見つかりません" }, { status: 404 });
  }
  return NextResponse.json({ rule });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // 参照(transactions.recurringRuleId)は残るため物理削除ではなく無効化
  const [rule] = await db
    .update(recurringRules)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(recurringRules.id, id))
    .returning();
  if (!rule) {
    return NextResponse.json({ error: "ルールが見つかりません" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
