import { NextResponse } from "next/server";
import { submitTransactionToMf } from "@/lib/integrations/mf-submit";

/**
 * 取引1件をMFクラウド経費へ直接提出する。
 * 成功時: status=submitted, mfTransactionId を保存して返す。
 * 失敗時: DBは変更せず、理由付きエラーを返す（未設定=503 / MF失敗=502）。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await submitTransactionToMf(id);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    transaction: result.transaction,
    mfTransactionId: result.mfTransactionId,
  });
}
