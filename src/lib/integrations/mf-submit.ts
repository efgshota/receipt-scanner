import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  createMfTransaction,
  getMfConfigStatus,
  mfCompanyForBucket,
} from "@/lib/integrations/mf-expense-api";

type Row = typeof transactions.$inferSelect;

export type SubmitResult =
  | { ok: true; transaction: Row; mfTransactionId: string | null }
  | { ok: false; status: number; error: string };

/** MFレスポンスから取引IDを安全に取り出す（レスポンス形が会社/版で揺れるため複数候補を試す） */
function extractMfId(r: unknown): string | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const nested = (o.ex_transaction ?? o.transaction ?? o.data) as
    | Record<string, unknown>
    | undefined;
  const cand = o.id ?? nested?.id;
  return cand != null ? String(cand) : null;
}

/**
 * 取引1件をMFクラウド経費へ提出し、成功したらDBを submitted + mfTransactionId に更新する。
 * MF側が失敗した場合はDBを変更しない（status/mfTransactionId は据え置き）。
 */
export async function submitTransactionToMf(id: string): Promise<SubmitResult> {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, id));

  if (!tx) return { ok: false, status: 404, error: "取引が見つかりません" };

  // 二重送信防止
  if (tx.mfTransactionId) {
    return {
      ok: false,
      status: 409,
      error: `既にMFへ提出済みです（MF ID: ${tx.mfTransactionId}）`,
    };
  }
  // 承認済のみ提出可（未承認の自動提出を防ぐ）
  if (tx.status !== "approved") {
    return {
      ok: false,
      status: 400,
      error: "承認済の取引のみMFへ提出できます",
    };
  }
  const company = mfCompanyForBucket(tx.bucket);
  if (!company) {
    return {
      ok: false,
      status: 400,
      error:
        "このバケツはMFクラウド経費の対象外です（家族精算はMF MEで共有してください）",
    };
  }
  if (!tx.date) {
    return { ok: false, status: 400, error: "日付が無いため提出できません" };
  }
  if (!(tx.amount > 0)) {
    return { ok: false, status: 400, error: "金額が不正なため提出できません" };
  }

  // 認証情報/トークンの事前チェック（未設定なら 503 で明確に返す）
  const cfg = getMfConfigStatus(company);
  if (!cfg.configured) {
    return { ok: false, status: 503, error: cfg.reason ?? "MF未設定" };
  }

  let mfResult: unknown;
  try {
    mfResult = await createMfTransaction(company, {
      date: tx.date,
      amount: tx.amount,
      vendor: tx.vendor,
      description: tx.description,
      invoiceNumber: tx.invoiceNumber,
    });
  } catch (e) {
    return {
      ok: false,
      status: 502,
      error: `MF送信に失敗: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const mfTransactionId = extractMfId(mfResult);

  const [updated] = await db
    .update(transactions)
    .set({
      status: "submitted",
      submittedAt: new Date(),
      mfTransactionId,
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, id))
    .returning();

  return { ok: true, transaction: updated, mfTransactionId };
}
