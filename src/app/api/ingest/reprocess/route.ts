import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestLog, transactions } from "@/lib/db/schema";
import { and, eq, like, or } from "drizzle-orm";

/**
 * メール取込のやり直し。指定メッセージの取込ログと生成済み取引を消し、
 * 次回の ingest 実行で再処理させる（一括発行メールの複数PDF対応後の再取込等）。
 * 提出済み(submitted/attached)の取引が含まれる場合は安全のため拒否する。
 */
export async function POST(request: Request) {
  const { account, messageId } = await request.json();
  if (!account || !messageId) {
    return NextResponse.json(
      { error: "account と messageId は必須です" },
      { status: 400 }
    );
  }

  const src = `${account}:${messageId}`;
  const related = await db
    .select({
      id: transactions.id,
      status: transactions.status,
      sourceId: transactions.sourceId,
    })
    .from(transactions)
    .where(
      or(eq(transactions.sourceId, src), like(transactions.sourceId, `${src}#%`))
    );

  const locked = related.filter(
    (t) => t.status === "submitted" || t.status === "attached"
  );
  if (locked.length > 0) {
    return NextResponse.json(
      {
        error: `提出済みの取引が${locked.length}件あるため再取込できません。先に差戻ししてください。`,
        lockedIds: locked.map((t) => t.id),
      },
      { status: 409 }
    );
  }

  const deletedTx: string[] = [];
  for (const t of related) {
    await db.delete(transactions).where(eq(transactions.id, t.id));
    deletedTx.push(t.id);
  }
  await db
    .delete(ingestLog)
    .where(and(eq(ingestLog.account, account), eq(ingestLog.messageId, messageId)));

  return NextResponse.json({
    ok: true,
    deletedTransactions: deletedTx.length,
    note: "次回の ingest 実行（cron または ?only=ingest）で再取込されます",
  });
}
