import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  createMfTransaction,
  getMfConfigStatus,
  mfCompanyForBucket,
} from "@/lib/integrations/mf-expense-api";
import { raiseAlert } from "@/lib/integrations/token-store";

type Row = typeof transactions.$inferSelect;

export type SubmitResult =
  | { ok: true; transaction: Row; mfTransactionId: string | null }
  | { ok: false; status: number; error: string };

/** MFレスポンスから取引IDを安全に取り出す（レスポンス形の揺れに備え複数候補を試す） */
function extractMfId(r: unknown): string | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const nested = (o.ex_transaction ?? o.transaction ?? o.data) as
    | Record<string, unknown>
    | undefined;
  const cand = o.id ?? nested?.id;
  return cand != null ? String(cand) : null;
}

const MAX_RECEIPT_BYTES = 3.5 * 1024 * 1024; // Base64膨張(×1.33)を見込んだ上限

function contentTypeFromPath(p: string): string {
  const ext = p.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "pdf") return "application/pdf";
  return "image/jpeg";
}

/**
 * receiptImageUrl から画像バイト列を取得しBase64化する。
 * - http(s) = Vercel Blob等の公開URL → 直接fetch
 * - /uploads/... = ローカル開発 or デプロイ静的資産 → fs優先、だめなら自アプリへBasic認証fetch
 * 取得失敗やサイズ超過は null（添付なしで明細だけ登録する）。
 */
async function loadReceiptImage(
  url: string
): Promise<{ base64: string; contentType: string; filename: string } | null> {
  try {
    let buf: Buffer | null = null;

    if (url.startsWith("http")) {
      const res = await fetch(url);
      if (res.ok) buf = Buffer.from(await res.arrayBuffer());
    } else {
      // ローカルファイル（public/配下）
      const fs = await import("fs");
      const path = await import("path");
      const p = path.join(process.cwd(), "public", url);
      if (fs.existsSync(p)) {
        buf = fs.readFileSync(p);
      } else {
        // サーバレスでfsに無い場合: 自アプリの静的配信から取得（Basic認証はenvの値を使用）
        const origin =
          process.env.APP_ORIGIN ??
          (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
        const user = process.env.BASIC_AUTH_USER;
        const pass = process.env.BASIC_AUTH_PASSWORD;
        if (origin) {
          const headers: Record<string, string> = {};
          if (user && pass) {
            headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
          }
          const res = await fetch(`${origin}${url}`, { headers });
          if (res.ok) buf = Buffer.from(await res.arrayBuffer());
        }
      }
    }

    if (!buf || buf.length === 0 || buf.length > MAX_RECEIPT_BYTES) return null;

    const filename = url.split("/").pop()?.split("?")[0] ?? "receipt.jpg";
    return {
      base64: buf.toString("base64"),
      contentType: contentTypeFromPath(url),
      filename,
    };
  } catch {
    return null;
  }
}

/**
 * 取引1件をMFクラウド経費へ明細登録し、成功したらDBを submitted + mfTransactionId に更新する。
 * 領収書画像があれば証憑として添付（電子帳簿保存法対応）。
 * MF側が失敗した場合はDBを変更しない。
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

  // 認証情報/トークン/office/科目の事前チェック（未設定なら 503 で明確に返す）
  const cfg = await getMfConfigStatus(company);
  if (!cfg.configured) {
    return { ok: false, status: 503, error: cfg.reason ?? "MF未設定" };
  }

  // 領収書画像の添付（取得失敗時は添付なしで続行）
  const receiptImage = tx.receiptImageUrl
    ? await loadReceiptImage(tx.receiptImageUrl)
    : null;

  // ---- クレーム: 条件付きUPDATEで先取りし、並行実行（cron自動提出 × 手動一括提出）の
  // 二重送信を防ぐ。neon-httpはトランザクション不可のためこのCASが唯一の排他。
  const claimed = await db
    .update(transactions)
    .set({ status: "submitted", updatedAt: new Date() })
    .where(
      and(
        eq(transactions.id, id),
        eq(transactions.status, "approved"),
        isNull(transactions.mfTransactionId)
      )
    )
    .returning({ id: transactions.id });
  if (claimed.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "別の処理が先に提出中/提出済みです",
    };
  }

  let mfResult: unknown;
  try {
    mfResult = await createMfTransaction(company, {
      date: tx.date,
      amount: tx.amount,
      vendor: tx.vendor,
      description: tx.description,
      invoiceNumber: tx.invoiceNumber,
      receiptImage,
    });
  } catch (e) {
    // MF失敗: クレームを解放（approvedへ戻す）。戻し失敗は要注意なのでアラート
    try {
      await db
        .update(transactions)
        .set({ status: "approved", updatedAt: new Date() })
        .where(eq(transactions.id, id));
    } catch {
      await raiseAlert(
        "cron_error",
        `MF提出失敗後のステータス復旧に失敗: 取引 ${id.slice(0, 8)} を確認してください`
      );
    }
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
      submittedAt: new Date(),
      mfTransactionId,
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, id))
    .returning();

  if (!updated?.mfTransactionId && mfTransactionId === null) {
    // MFは成功したがIDを抽出できなかった: 二重提出防止のためsubmittedのまま検知可能にする
    await raiseAlert(
      "cron_error",
      `MF提出は成功しましたがIDを取得できませんでした: ${tx.vendor} ¥${tx.amount}（MF側で重複がないか確認）`
    );
  }

  return { ok: true, transaction: updated, mfTransactionId };
}
