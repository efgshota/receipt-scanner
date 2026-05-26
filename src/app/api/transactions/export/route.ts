import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { desc, eq, and, gte, lte, type SQL } from "drizzle-orm";
import type { TransactionStatus, Bucket } from "@/lib/types";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") as TransactionStatus | null;
  const bucket = searchParams.get("bucket") as Bucket | null;
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const filters: SQL[] = [];
  if (status) filters.push(eq(transactions.status, status));
  if (bucket) filters.push(eq(transactions.bucket, bucket));
  if (from) filters.push(gte(transactions.date, from));
  if (to) filters.push(lte(transactions.date, to));

  const rows = await db
    .select()
    .from(transactions)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(transactions.date));

  const header = [
    "日付",
    "店舗",
    "金額",
    "バケット",
    "ステータス",
    "説明",
    "インボイス番号",
    "ソース",
    "確信度",
    "分類理由",
    "ID",
  ];

  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };

  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.date ?? "",
        r.vendor,
        r.amount,
        r.bucket ?? "",
        r.status,
        r.description ?? "",
        r.invoiceNumber ?? "",
        r.source,
        r.confidence ?? "",
        r.classificationReason ?? "",
        r.id,
      ]
        .map(escape)
        .join(",")
    );
  }

  // BOM for Excel Japanese support
  const csv = "﻿" + lines.join("\n");
  const filename = `receipts-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
