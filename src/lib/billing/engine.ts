import { db } from "@/lib/db";
import {
  billingClients,
  invoiceSchedules,
  invoices,
} from "@/lib/db/schema";
import { and, eq, gte, lte } from "drizzle-orm";
import {
  createBilling,
  getMfInvoiceStatus,
  type InvoiceItemInput,
} from "@/lib/integrations/mf-invoice-api";
import { monthKey } from "@/lib/recurring/engine";
import { raiseAlert } from "@/lib/integrations/token-store";

/**
 * 請求書の定期起票＋遅延防止エンジン。
 *
 * 「発行が遅れる」問題への設計:
 * 1. 月次スケジュール（顧問料等）は発行日にMFへドラフト自動作成 → 人は送付だけ
 * 2. MF未接続でもローカルにドラフト行を作る → ダッシュボードに「未発行」警告が出続ける
 * 3. メール送付APIは存在しないため、送付はMF UIで行い状態を進める
 */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function lastDayOfMonth(y: number, m1to12: number): number {
  return new Date(y, m1to12, 0).getDate();
}

/** dueRule から支払期日を計算（issueDate基準） */
export function computeDueDate(issueDate: string, dueRule: string): string {
  const [y, m] = issueDate.split("-").map(Number);
  if (dueRule === "end_of_month") {
    return `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`;
  }
  // デフォルト: 翌月末
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${pad(nm)}-${pad(lastDayOfMonth(ny, nm))}`;
}

export interface BillingGenerateSummary {
  createdLocal: number;
  createdInMf: number;
  skipped: number;
  errors: string[];
}

/**
 * 月次スケジュールから当月分の請求書を起票する（冪等）。
 * MF接続済み+取引先にdepartment設定済みならMFにドラフト作成まで行う。
 */
export async function generateScheduledInvoices(
  now: Date
): Promise<BillingGenerateSummary> {
  const mk = monthKey(now);
  const today = now.getDate();
  const summary: BillingGenerateSummary = {
    createdLocal: 0,
    createdInMf: 0,
    skipped: 0,
    errors: [],
  };

  const schedules = await db
    .select()
    .from(invoiceSchedules)
    .where(eq(invoiceSchedules.active, true));
  const mfStatus = await getMfInvoiceStatus();

  for (const sched of schedules) {
    try {
      if (sched.issueDayOfMonth > today) {
        summary.skipped++;
        continue;
      }
      // 冪等ガード: 当月分の請求書行を検索。
      // MF作成済み or 手動処理済み（sent/paid等）ならスキップ。
      // 「draftのままMF未作成」の行は再利用してMF作成のみ再試行する
      // （MF一時エラー・後からの取引先紐付けから自動復旧するため）。
      const { start, end } = {
        start: `${mk}-01`,
        end: `${mk}-${pad(lastDayOfMonth(...(mk.split("-").map(Number) as [number, number])))}`,
      };
      const existing = await db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.scheduleId, sched.id),
            gte(invoices.issueDate, start),
            lte(invoices.issueDate, end)
          )
        );
      const retryDraft = existing.find(
        (v) => v.status === "draft" && !v.mfInvoiceId
      );
      if (existing.length > 0 && !retryDraft) {
        summary.skipped++;
        continue;
      }

      const issueDate = retryDraft?.issueDate ?? `${mk}-${pad(sched.issueDayOfMonth)}`;
      const dueDate = retryDraft?.dueDate ?? computeDueDate(issueDate, sched.dueRule);
      const items =
        (retryDraft?.items as InvoiceItemInput[] | null) ??
        (sched.items as InvoiceItemInput[] | null) ?? [
          { name: sched.title, price: sched.amount, quantity: 1 },
        ];

      // ローカルドラフト行（MF失敗でも「未発行」が可視化される）— 再試行時は既存を使う
      const localInvoice =
        retryDraft ??
        (
          await db
            .insert(invoices)
            .values({
              kind: "invoice",
              status: "draft",
              clientId: sched.clientId,
              scheduleId: sched.id,
              title: sched.title,
              amount: sched.amount,
              taxRate: sched.taxRate,
              issueDate,
              dueDate,
              items,
            })
            .returning()
        )[0];
      if (!retryDraft) summary.createdLocal++;

      // MFへドラフト作成
      if (mfStatus.configured) {
        const [client] = await db
          .select()
          .from(billingClients)
          .where(eq(billingClients.id, sched.clientId));
        if (client?.mfDepartmentId) {
          const mf = await createBilling({
            departmentId: client.mfDepartmentId,
            title: sched.title,
            billingDate: issueDate,
            salesDate: issueDate,
            dueDate,
            items,
          });
          await db
            .update(invoices)
            .set({
              status: "created_in_mf",
              mfInvoiceId: mf.id,
              mfPdfUrl: mf.pdfUrl,
              updatedAt: new Date(),
            })
            .where(eq(invoices.id, localInvoice.id));
          summary.createdInMf++;
        } else {
          summary.errors.push(
            `${sched.title}: 取引先にMF部署(department)が未設定のためMF起票をスキップ`
          );
        }
      }

      await db
        .update(invoiceSchedules)
        .set({ lastGeneratedMonth: mk, updatedAt: new Date() })
        .where(eq(invoiceSchedules.id, sched.id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      summary.errors.push(`${sched.title}: ${msg}`);
      await raiseAlert("cron_error", `請求書自動起票に失敗: ${sched.title}: ${msg}`);
    }
  }
  return summary;
}

export interface BillingAlert {
  level: "error" | "warn";
  message: string;
  invoiceId?: string;
}

/** 請求まわりの遅延・要対応アラート（ダッシュボード表示用） */
export async function listBillingAlerts(now: Date): Promise<BillingAlert[]> {
  const alerts: BillingAlert[] = [];
  const today = now.toISOString().slice(0, 10);

  const rows = await db
    .select({
      id: invoices.id,
      title: invoices.title,
      status: invoices.status,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      clientName: billingClients.name,
    })
    .from(invoices)
    .leftJoin(billingClients, eq(invoices.clientId, billingClients.id));

  for (const r of rows) {
    const name = r.clientName ? `${r.clientName} / ${r.title}` : r.title;
    if (r.status === "draft" && r.issueDate && r.issueDate <= today) {
      alerts.push({
        level: "error",
        message: `請求書未発行: ${name}（発行予定 ${r.issueDate}）— MF未作成`,
        invoiceId: r.id,
      });
    } else if (r.status === "created_in_mf") {
      alerts.push({
        level: "warn",
        message: `送付待ち: ${name} — MFにドラフト作成済み。MF UIから送付してください`,
        invoiceId: r.id,
      });
    } else if (
      r.status === "sent" &&
      r.dueDate &&
      r.dueDate < today
    ) {
      alerts.push({
        level: "warn",
        message: `入金確認: ${name}（支払期日 ${r.dueDate} 超過）`,
        invoiceId: r.id,
      });
    }
  }
  return alerts;
}
