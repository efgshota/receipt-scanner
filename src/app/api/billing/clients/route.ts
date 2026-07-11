import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { billingClients } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";

export async function GET() {
  const clients = await db
    .select()
    .from(billingClients)
    .orderBy(desc(billingClients.createdAt));
  return NextResponse.json({ clients });
}

export async function POST(request: Request) {
  const b = await request.json().catch(() => ({}));
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name は必須です" }, { status: 400 });
  }
  const [client] = await db
    .insert(billingClients)
    .values({
      name,
      mfPartnerId: typeof b.mfPartnerId === "string" ? b.mfPartnerId : null,
      mfDepartmentId:
        typeof b.mfDepartmentId === "string" ? b.mfDepartmentId : null,
      defaultTitle: typeof b.defaultTitle === "string" ? b.defaultTitle : null,
      notes: typeof b.notes === "string" ? b.notes : null,
    })
    .returning();
  return NextResponse.json({ client });
}

export async function PATCH(request: Request) {
  const b = await request.json().catch(() => ({}));
  if (typeof b.id !== "string") {
    return NextResponse.json({ error: "id は必須です" }, { status: 400 });
  }
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof b.name === "string" && b.name.trim()) set.name = b.name.trim();
  if (typeof b.mfPartnerId === "string") set.mfPartnerId = b.mfPartnerId || null;
  if (typeof b.mfDepartmentId === "string")
    set.mfDepartmentId = b.mfDepartmentId || null;
  if (typeof b.defaultTitle === "string") set.defaultTitle = b.defaultTitle;
  if (typeof b.notes === "string") set.notes = b.notes;

  const [client] = await db
    .update(billingClients)
    .set(set)
    .where(eq(billingClients.id, b.id))
    .returning();
  if (!client) {
    return NextResponse.json({ error: "取引先が見つかりません" }, { status: 404 });
  }
  return NextResponse.json({ client });
}
