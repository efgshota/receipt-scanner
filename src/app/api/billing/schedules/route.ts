import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { billingClients, invoiceSchedules } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";

export async function GET() {
  const schedules = await db
    .select({
      schedule: invoiceSchedules,
      clientName: billingClients.name,
    })
    .from(invoiceSchedules)
    .leftJoin(billingClients, eq(invoiceSchedules.clientId, billingClients.id))
    .orderBy(desc(invoiceSchedules.createdAt));
  return NextResponse.json({
    schedules: schedules.map((s) => ({ ...s.schedule, clientName: s.clientName })),
  });
}

export async function POST(request: Request) {
  const b = await request.json().catch(() => ({}));
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const amount = Number(b.amount);
  if (!b.clientId || !title) {
    return NextResponse.json(
      { error: "clientId / title は必須です" },
      { status: 400 }
    );
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return NextResponse.json(
      { error: "amount は正の整数（税抜）で指定してください" },
      { status: 400 }
    );
  }
  const [schedule] = await db
    .insert(invoiceSchedules)
    .values({
      clientId: b.clientId,
      title,
      amount,
      taxRate: typeof b.taxRate === "number" ? b.taxRate : 0.1,
      issueDayOfMonth: Math.min(28, Math.max(1, Number(b.issueDayOfMonth) || 25)),
      dueRule: typeof b.dueRule === "string" ? b.dueRule : "end_of_next_month",
      items: Array.isArray(b.items) ? b.items : null,
    })
    .returning();
  return NextResponse.json({ schedule });
}

export async function PATCH(request: Request) {
  const b = await request.json().catch(() => ({}));
  if (typeof b.id !== "string") {
    return NextResponse.json({ error: "id は必須です" }, { status: 400 });
  }
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof b.title === "string" && b.title.trim()) set.title = b.title.trim();
  if (Number.isInteger(b.amount) && b.amount > 0) set.amount = b.amount;
  if (typeof b.taxRate === "number") set.taxRate = b.taxRate;
  if (Number.isInteger(b.issueDayOfMonth))
    set.issueDayOfMonth = Math.min(28, Math.max(1, b.issueDayOfMonth));
  if (typeof b.dueRule === "string") set.dueRule = b.dueRule;
  if (typeof b.active === "boolean") set.active = b.active;
  if (Array.isArray(b.items)) set.items = b.items;

  const [schedule] = await db
    .update(invoiceSchedules)
    .set(set)
    .where(eq(invoiceSchedules.id, b.id))
    .returning();
  if (!schedule) {
    return NextResponse.json(
      { error: "スケジュールが見つかりません" },
      { status: 404 }
    );
  }
  return NextResponse.json({ schedule });
}
