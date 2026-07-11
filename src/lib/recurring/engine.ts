import { db } from "@/lib/db";
import { recurringRules, transactions } from "@/lib/db/schema";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { submitTransactionToMf } from "@/lib/integrations/mf-submit";
import { mfCompanyForBucket } from "@/lib/integrations/mf-expense-api";
import { raiseAlert } from "@/lib/integrations/token-store";

export type RecurringRule = typeof recurringRules.$inferSelect;

/**
 * サブスク（定期支出）自動計上エンジン。
 *
 * 設計原則: cronは欠落も重複発火もありうるため、全処理を照合ベースで冪等にする。
 * - 生成: 「当月分の取引が存在しなければ作る」（last_generated_month は補助ガード）
 * - 提出: 「approved かつ 未提出(mfTransactionId無し) を全部処理」
 */

export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthRange(mk: string): { start: string; end: string } {
  const [y, m] = mk.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { start: `${mk}-01`, end: `${mk}-${String(last).padStart(2, "0")}` };
}

export function amountWithinTolerance(
  rule: Pick<RecurringRule, "expectedAmount" | "amountTolerance">,
  amount: number
): boolean {
  const lo = rule.expectedAmount * (1 - rule.amountTolerance);
  const hi = rule.expectedAmount * (1 + rule.amountTolerance);
  return amount >= lo && amount <= hi;
}

/** vendor文字列にマッチするactiveルールを探す（金額は見ない: 判定は呼び出し側） */
export async function matchRecurringRule(
  vendor: string
): Promise<RecurringRule | null> {
  const rules = await db
    .select()
    .from(recurringRules)
    .where(eq(recurringRules.active, true));
  const v = vendor.toLowerCase();
  // より長いパターン＝より特異的なルールを優先
  const matched = rules
    .filter((r) => v.includes(r.vendorPattern.toLowerCase()))
    .sort((a, b) => b.vendorPattern.length - a.vendorPattern.length);
  return matched[0] ?? null;
}

/** 当月分のルール生成済み取引を探す */
export async function findGeneratedTransaction(
  ruleId: string,
  mk: string
): Promise<typeof transactions.$inferSelect | null> {
  const { start, end } = monthRange(mk);
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.recurringRuleId, ruleId),
        gte(transactions.date, start),
        lte(transactions.date, end)
      )
    );
  return rows[0] ?? null;
}

export interface GenerateSummary {
  generated: number;
  skipped: number;
  errors: string[];
}

/**
 * 月次生成: dayOfMonth に達したactiveルールから当月分の経費エントリを作成。
 * autoSubmit=true なら status=approved（提出は autoSubmitRecurring が担当）。
 */
export async function generateRecurringTransactions(
  now: Date
): Promise<GenerateSummary> {
  const mk = monthKey(now);
  const today = now.getDate();
  const summary: GenerateSummary = { generated: 0, skipped: 0, errors: [] };

  const rules = await db
    .select()
    .from(recurringRules)
    .where(eq(recurringRules.active, true));

  for (const rule of rules) {
    try {
      if (rule.dayOfMonth > today) {
        summary.skipped++;
        continue;
      }
      // 冪等ガード: 当月分が既にある、または当月生成済みマークが立っていればスキップ。
      // 「マークあり・取引なし」は再生成しない — その状態はユーザーの意図的な
      // 削除/日付訂正で生じるのが実際のケースであり、作り直すと重複計上になる。
      const existing = await findGeneratedTransaction(rule.id, mk);
      if (existing || rule.lastGeneratedMonth === mk) {
        summary.skipped++;
        continue;
      }

      const date = `${mk}-${String(rule.dayOfMonth).padStart(2, "0")}`;
      await db.insert(transactions).values({
        source: "recurring",
        vendor: rule.name,
        amount: rule.expectedAmount,
        date,
        description: rule.notes ?? "サブスク自動計上",
        bucket: rule.bucket,
        confidence: 1.0,
        classificationReason: `recurring_rule: ${rule.name}`,
        status: rule.autoSubmit ? "approved" : "classified",
        recurringRuleId: rule.id,
      });
      await db
        .update(recurringRules)
        .set({ lastGeneratedMonth: mk, updatedAt: new Date() })
        .where(eq(recurringRules.id, rule.id));
      summary.generated++;
    } catch (e) {
      summary.errors.push(
        `${rule.name}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  return summary;
}

export interface AutoSubmitSummary {
  submitted: number;
  failed: { id: string; error: string }[];
}

/**
 * 自動提出: approved かつ 未提出 かつ autoSubmitルール由来 かつ MF対象バケツの取引を
 * MFクラウド経費へ明細登録する。1回の実行での提出数は maxPerRun で制限。
 */
export async function autoSubmitRecurring(
  maxPerRun = 15
): Promise<AutoSubmitSummary> {
  const summary: AutoSubmitSummary = { submitted: 0, failed: [] };

  const rows = await db
    .select({
      id: transactions.id,
      bucket: transactions.bucket,
      ruleId: transactions.recurringRuleId,
      autoSubmit: recurringRules.autoSubmit,
    })
    .from(transactions)
    .innerJoin(
      recurringRules,
      eq(transactions.recurringRuleId, recurringRules.id)
    )
    .where(
      and(
        eq(transactions.status, "approved"),
        isNull(transactions.mfTransactionId)
      )
    );

  const targets = rows
    .filter((r) => r.autoSubmit && mfCompanyForBucket(r.bucket) !== null)
    .slice(0, maxPerRun);

  for (const t of targets) {
    const result = await submitTransactionToMf(t.id);
    if (result.ok) {
      summary.submitted++;
    } else {
      summary.failed.push({ id: t.id, error: result.error });
      // MF未設定(503)なら以降も全部同じ理由で失敗するため中断
      if (result.status === 503) {
        await raiseAlert("cron_error", `サブスク自動提出が停止: ${result.error}`);
        break;
      }
    }
    // MF APIへの配慮（レート制限は非公表のため保守的に）
    await new Promise((r) => setTimeout(r, 300));
  }
  return summary;
}
