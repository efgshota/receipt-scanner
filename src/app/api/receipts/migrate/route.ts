import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import path from "path";

// 旧ローカル保存(/uploads/…)の証憑をBlobへ移す移行用。
// 本番はBlobトークンをサーバ側だけが持つため、ファイルはこのエンドポイント経由で受け取る。
export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "BLOB_READ_WRITE_TOKEN が未設定です" },
      { status: 503 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const transactionId = formData.get("transactionId") as string | null;

  if (!file || !transactionId) {
    return NextResponse.json(
      { error: "file と transactionId は必須です" },
      { status: 400 }
    );
  }

  const [existing] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, transactionId));

  if (!existing) {
    return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
  }

  // 冪等: すでにBlob移行済みなら何もしない
  const current = existing.receiptImageUrl ?? "";
  if (current.includes("blob.vercel-storage.com")) {
    return NextResponse.json({ url: current, skipped: true });
  }
  if (!current.startsWith("/uploads/")) {
    return NextResponse.json(
      { error: `移行対象外のURLです: ${current || "(なし)"}` },
      { status: 409 }
    );
  }

  const basename = path.basename(current);
  const blob = await put(`receipts/migrated/${basename}`, file, {
    access: "public",
    addRandomSuffix: false,
  });

  await db
    .update(transactions)
    .set({ receiptImageUrl: blob.url, updatedAt: new Date() })
    .where(eq(transactions.id, transactionId));

  return NextResponse.json({ url: blob.url, previous: current });
}
