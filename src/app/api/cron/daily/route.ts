import { NextResponse } from "next/server";
import { runEmailIngest } from "@/lib/ingest/email-receipts";
import { runImapIngest } from "@/lib/ingest/imap-receipts";
import {
  generateRecurringTransactions,
  autoSubmitRecurring,
} from "@/lib/recurring/engine";
import { generateScheduledInvoices } from "@/lib/billing/engine";
import { raiseAlert } from "@/lib/integrations/token-store";

/**
 * 日次バッチ（Vercel Cron: JST早朝）。全フェーズ照合ベースで冪等 —
 * cronの欠落・重複発火・途中失敗いずれでも自己修復する。
 *
 * 認証: middleware が (a) Basic認証ユーザー (b) Bearer CRON_SECRET のみ通す。
 * Vercel Cron は CRON_SECRET env があると Authorization: Bearer を自動付与する。
 */
export const maxDuration = 300; // Hobby+Fluid Compute の上限

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const only = searchParams.get("only"); // デバッグ用: ingest|recurring|submit|billing
  const days = Number(searchParams.get("days") ?? "3");
  // バックフィル用（手動実行時のみ想定）: q=検索語上書き / max=1アカウント処理上限
  const q = searchParams.get("q") ?? undefined;
  const max = searchParams.get("max");

  const startedAt = Date.now();
  const result: Record<string, unknown> = {};
  const phaseErrors: string[] = [];

  const phase = async (name: string, fn: () => Promise<unknown>) => {
    if (only && only !== name) return;
    try {
      result[name] = await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result[name] = { error: msg };
      phaseErrors.push(`${name}: ${msg}`);
    }
  };

  // フェーズ順: 軽量で決定的なもの（生成・起票・提出）を先に、時間を食う
  // メール取込を最後に置く。取込が時間切れでも遅延防止系は必ず毎日実行される。
  // 各フェーズは相互依存なし（取込のサブスク突合は翌日の実行でも自己修復する）。

  // 1) サブスク定期生成
  await phase("recurring", () => generateRecurringTransactions(new Date()));
  // 2) 請求書の定期起票（MFドラフト作成 — 発行遅延防止の本丸）
  await phase("billing", () => generateScheduledInvoices(new Date()));
  // 3) 自動承認済みのMF明細登録（証憑添付込み）
  await phase("submit", () => autoSubmitRecurring());
  // 4) IMAP取込（efg@nagi-inc.jp等・軽量なのでGmailより先。60秒上限）
  await phase("imap", () =>
    runImapIngest({
      newerThanDays: Number.isFinite(days) ? days : 3,
      deadlineMs: startedAt + 60_000,
    })
  );
  // 5) メール領収書取込（サブスク突合込み）
  // 時間バジェット: maxDuration(300s)の手前で切り上げ。未処理分は冪等設計
  // （newer_than窓+dedup）により翌日の実行で自動的に拾われる。
  await phase("ingest", () =>
    runEmailIngest({
      newerThanDays: Number.isFinite(days) ? days : 3,
      deadlineMs: startedAt + 240_000,
      queryTerms: q,
      maxPerAccount: max ? Number(max) : undefined,
    })
  );

  if (phaseErrors.length > 0) {
    await raiseAlert("cron_error", `日次バッチ一部失敗: ${phaseErrors.join(" / ")}`);
  }

  return NextResponse.json({
    ok: phaseErrors.length === 0,
    tookMs: Date.now() - startedAt,
    ...result,
  });
}
