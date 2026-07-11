import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recurringRules } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import type { Bucket } from "@/lib/types";

export async function GET() {
  const rules = await db
    .select()
    .from(recurringRules)
    .orderBy(desc(recurringRules.createdAt));
  return NextResponse.json({ rules });
}

export async function POST(request: Request) {
  const b = await request.json().catch(() => ({}));
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const vendorPattern =
    typeof b.vendorPattern === "string" ? b.vendorPattern.trim() : "";
  const expectedAmount = Number(b.expectedAmount);
  const bucket = b.bucket as Bucket;

  if (!name || !vendorPattern) {
    return NextResponse.json(
      { error: "name / vendorPattern は必須です" },
      { status: 400 }
    );
  }
  if (!Number.isInteger(expectedAmount) || expectedAmount <= 0) {
    return NextResponse.json(
      { error: "expectedAmount は正の整数で指定してください" },
      { status: 400 }
    );
  }
  if (!["nagi", "stadiums", "family"].includes(bucket)) {
    return NextResponse.json({ error: "bucket が不正です" }, { status: 400 });
  }
  const dayOfMonth = Math.min(28, Math.max(1, Number(b.dayOfMonth) || 1));

  const [rule] = await db
    .insert(recurringRules)
    .values({
      name,
      vendorPattern,
      bucket,
      expectedAmount,
      amountTolerance:
        typeof b.amountTolerance === "number" ? b.amountTolerance : 0.2,
      dayOfMonth,
      autoSubmit: b.autoSubmit !== false,
      notes: typeof b.notes === "string" ? b.notes : null,
    })
    .returning();
  return NextResponse.json({ rule });
}
