import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestLog } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

/** メール取込ログ（設定画面の動作確認用） */
export async function GET() {
  const logs = await db
    .select()
    .from(ingestLog)
    .orderBy(desc(ingestLog.createdAt))
    .limit(50);
  return NextResponse.json({ logs });
}
