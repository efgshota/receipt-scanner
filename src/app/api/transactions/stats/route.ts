import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import type { Bucket, TransactionStatus } from "@/lib/types";

const BUCKETS: Bucket[] = ["nagi", "stadiums", "family"];
const STATUSES: TransactionStatus[] = [
  "pending",
  "classified",
  "approved",
  "submitted",
  "attached",
  "rejected",
];

interface StatusCell {
  count: number;
  amount: number;
}

interface BucketStat {
  bucket: Bucket;
  total: { count: number; amount: number };
  byStatus: Record<TransactionStatus, StatusCell>;
  // 精算完了率（提出済+添付済 / 全体）件数ベース
  submittedRate: number;
  // 残り（未提出）件数・金額
  remaining: { count: number; amount: number };
}

function emptyByStatus(): Record<TransactionStatus, StatusCell> {
  return STATUSES.reduce(
    (acc, s) => {
      acc[s] = { count: 0, amount: 0 };
      return acc;
    },
    {} as Record<TransactionStatus, StatusCell>
  );
}

// 精算が「終わった」とみなすステータス
const DONE_STATUSES: TransactionStatus[] = ["submitted", "attached"];

export async function GET() {
  // bucket × status の件数・金額を一括集計
  const rows = await db
    .select({
      bucket: transactions.bucket,
      status: transactions.status,
      count: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${transactions.amount}),0)::int`,
    })
    .from(transactions)
    .groupBy(transactions.bucket, transactions.status);

  const buckets: Record<string, BucketStat> = {};
  for (const b of BUCKETS) {
    buckets[b] = {
      bucket: b,
      total: { count: 0, amount: 0 },
      byStatus: emptyByStatus(),
      submittedRate: 0,
      remaining: { count: 0, amount: 0 },
    };
  }

  let unbucketedCount = 0;
  let unbucketedAmount = 0;

  for (const r of rows) {
    if (!r.bucket) {
      unbucketedCount += r.count;
      unbucketedAmount += r.amount;
      continue;
    }
    const bs = buckets[r.bucket];
    if (!bs) continue;
    const cell = bs.byStatus[r.status as TransactionStatus];
    if (cell) {
      cell.count = r.count;
      cell.amount = r.amount;
    }
    bs.total.count += r.count;
    bs.total.amount += r.amount;
  }

  for (const b of BUCKETS) {
    const bs = buckets[b];
    const done = DONE_STATUSES.reduce((n, s) => n + bs.byStatus[s].count, 0);
    const notDone = STATUSES.filter(
      (s) => !DONE_STATUSES.includes(s) && s !== "rejected"
    );
    bs.remaining = {
      count: notDone.reduce((n, s) => n + bs.byStatus[s].count, 0),
      amount: notDone.reduce((n, s) => n + bs.byStatus[s].amount, 0),
    };
    // 分母から rejected を除外（却下があっても 100% に到達できるように）
    const denom = done + bs.remaining.count;
    bs.submittedRate = denom > 0 ? done / denom : 0;
  }

  const grand = {
    count: Object.values(buckets).reduce((n, b) => n + b.total.count, 0) + unbucketedCount,
    amount: Object.values(buckets).reduce((n, b) => n + b.total.amount, 0) + unbucketedAmount,
  };

  return NextResponse.json({
    buckets: BUCKETS.map((b) => buckets[b]),
    unbucketed: { count: unbucketedCount, amount: unbucketedAmount },
    grand,
  });
}
