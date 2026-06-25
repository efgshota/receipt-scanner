import { NextResponse } from "next/server";
import { submitTransactionToMf } from "@/lib/integrations/mf-submit";

/**
 * 複数の取引をMFクラウド経費へ順次提出する。
 * body: { ids: string[] }  ← 承認済の対象ID（クライアントで抽出）
 * 各IDは submitTransactionToMf 内で status=approved / バケツ→会社 を再検証するため安全。
 * MF未設定(503)を検知したら以降は中断して理由を返す（無駄な連打を防ぐ）。
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const ids = body?.ids;

  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === "string")) {
    return NextResponse.json(
      { error: "ids（提出対象IDの配列）が必要です" },
      { status: 400 }
    );
  }

  const succeeded: { id: string; mfTransactionId: string | null }[] = [];
  const failed: { id: string; error: string }[] = [];
  let aborted: string | null = null;

  for (const id of ids) {
    const r = await submitTransactionToMf(id);
    if (r.ok) {
      succeeded.push({ id, mfTransactionId: r.mfTransactionId });
    } else {
      failed.push({ id, error: r.error });
      // 未設定/再認証が必要な場合は全件同じ理由で失敗するため中断
      if (r.status === 503) {
        aborted = r.error;
        break;
      }
    }
  }

  return NextResponse.json({
    submitted: succeeded.length,
    failedCount: failed.length,
    succeeded,
    failed,
    aborted,
  });
}
