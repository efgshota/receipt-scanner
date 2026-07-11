import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recurringRules, transactions } from "@/lib/db/schema";
import { isNotNull, and, gt } from "drizzle-orm";

/**
 * 取引履歴からサブスク候補を提案する。
 * 条件: 同一ベンダーが2ヶ月以上に出現 + 金額のばらつきが小さい（中央値±30%に収まる）。
 * 既存ルールでカバー済みのベンダーは除外。
 */
export async function GET() {
  const [rows, rules] = await Promise.all([
    db
      .select({
        vendor: transactions.vendor,
        amount: transactions.amount,
        date: transactions.date,
        bucket: transactions.bucket,
      })
      .from(transactions)
      .where(and(isNotNull(transactions.date), gt(transactions.amount, 0))),
    db.select().from(recurringRules),
  ]);

  const covered = rules.map((r) => r.vendorPattern.toLowerCase());

  interface Group {
    vendor: string;
    months: Set<string>;
    amounts: number[];
    buckets: Map<string, number>;
    days: number[];
  }
  const groups = new Map<string, Group>();

  for (const r of rows) {
    if (!r.date) continue;
    const key = r.vendor.trim().toLowerCase();
    if (!key || key === "unknown") continue;
    if (covered.some((p) => key.includes(p))) continue;

    let g = groups.get(key);
    if (!g) {
      g = {
        vendor: r.vendor.trim(),
        months: new Set(),
        amounts: [],
        buckets: new Map(),
        days: [],
      };
      groups.set(key, g);
    }
    g.months.add(r.date.slice(0, 7));
    g.amounts.push(r.amount);
    g.days.push(Number(r.date.slice(8, 10)));
    if (r.bucket) g.buckets.set(r.bucket, (g.buckets.get(r.bucket) ?? 0) + 1);
  }

  const suggestions = [];
  for (const g of groups.values()) {
    if (g.months.size < 2) continue;
    const sorted = [...g.amounts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const stable = g.amounts.every(
      (a) => a >= median * 0.7 && a <= median * 1.3
    );
    if (!stable) continue;

    const topBucket =
      [...g.buckets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "nagi";
    const medianDay =
      [...g.days].sort((a, b) => a - b)[Math.floor(g.days.length / 2)] ?? 1;

    suggestions.push({
      name: g.vendor,
      vendorPattern: g.vendor,
      expectedAmount: median,
      bucket: topBucket,
      dayOfMonth: Math.min(28, medianDay),
      occurrences: g.amounts.length,
      monthsSeen: g.months.size,
    });
  }

  suggestions.sort((a, b) => b.monthsSeen - a.monthsSeen);
  return NextResponse.json({ suggestions: suggestions.slice(0, 20) });
}
