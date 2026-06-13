import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import type { TransactionStatus, Bucket } from "@/lib/types";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") as TransactionStatus | null;
  const bucket = searchParams.get("bucket") as Bucket | null;

  let query = db.select().from(transactions).orderBy(desc(transactions.date));

  if (status) {
    query = query.where(eq(transactions.status, status)) as typeof query;
  }
  if (bucket) {
    query = query.where(eq(transactions.bucket, bucket)) as typeof query;
  }

  const results = await query.limit(1000);

  return NextResponse.json({ transactions: results });
}
