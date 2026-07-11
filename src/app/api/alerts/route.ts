import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { systemAlerts } from "@/lib/db/schema";
import { desc, eq, isNull } from "drizzle-orm";
import { listBillingAlerts } from "@/lib/billing/engine";

/** 未解決のシステムアラート + 請求まわりの要対応事項（ダッシュボードのバナー用） */
export async function GET() {
  const [system, billing] = await Promise.all([
    db
      .select()
      .from(systemAlerts)
      .where(isNull(systemAlerts.resolvedAt))
      .orderBy(desc(systemAlerts.createdAt))
      .limit(20),
    listBillingAlerts(new Date()),
  ]);
  return NextResponse.json({ system, billing });
}

/** アラート解決 body: { id } */
export async function POST(request: Request) {
  const b = await request.json().catch(() => ({}));
  if (typeof b.id !== "string") {
    return NextResponse.json({ error: "id は必須です" }, { status: 400 });
  }
  await db
    .update(systemAlerts)
    .set({ resolvedAt: new Date() })
    .where(eq(systemAlerts.id, b.id));
  return NextResponse.json({ ok: true });
}
