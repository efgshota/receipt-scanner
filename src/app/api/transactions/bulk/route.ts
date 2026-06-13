import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { Bucket, TransactionStatus } from "@/lib/types";
import { ALLOWED_FROM, isValidStatus } from "@/lib/status-transitions";

/**
 * 一括ステータス更新。
 * body: {
 *   toStatus: TransactionStatus               (必須)
 *   bucket?: Bucket                            (バケツで絞り込み)
 *   fromStatus?: TransactionStatus[]           (この状態の行のみ遷移＝必須の安全弁)
 *   ids?: string[]                             (明示ID指定)
 * }
 * 安全規則: fromStatus は必須。toStatus への正当な前ステータスのみ許可する
 *           （未承認/却下を提出済にする等の不正遷移をサーバ側で防止）。
 */
export async function POST(request: Request) {
  const body = await request.json();
  const toStatus = body.toStatus;

  if (!isValidStatus(toStatus)) {
    return NextResponse.json(
      { error: "toStatus が不正です" },
      { status: 400 }
    );
  }

  // fromStatus は必須。正当な前ステータスのサブセットであることを検証。
  const fromStatus = body.fromStatus;
  if (
    !Array.isArray(fromStatus) ||
    fromStatus.length === 0 ||
    !fromStatus.every((s: unknown) => isValidStatus(s))
  ) {
    return NextResponse.json(
      { error: "fromStatus（対象ステータスの配列）が必要です" },
      { status: 400 }
    );
  }
  const legal = ALLOWED_FROM[toStatus as TransactionStatus];
  const illegal = (fromStatus as TransactionStatus[]).filter(
    (s) => !legal.includes(s)
  );
  if (illegal.length > 0) {
    return NextResponse.json(
      {
        error: `不正な遷移: ${illegal.join(",")} → ${toStatus} は許可されていません`,
      },
      { status: 400 }
    );
  }

  const filters: SQL[] = [
    inArray(transactions.status, fromStatus as TransactionStatus[]),
  ];
  if (body.ids && Array.isArray(body.ids) && body.ids.length > 0) {
    filters.push(inArray(transactions.id, body.ids as string[]));
  }
  if (body.bucket) {
    filters.push(eq(transactions.bucket, body.bucket as Bucket));
  }

  const updateData: Record<string, unknown> = {
    status: toStatus,
    updatedAt: new Date(),
  };
  if (toStatus === "submitted" || toStatus === "attached") {
    updateData.submittedAt = new Date();
  } else {
    // 提出済から戻す（差戻し/却下など）場合は提出日時をクリア
    updateData.submittedAt = null;
  }

  const updated = await db
    .update(transactions)
    .set(updateData)
    .where(and(...filters))
    .returning({ id: transactions.id });

  return NextResponse.json({ updated: updated.length });
}
