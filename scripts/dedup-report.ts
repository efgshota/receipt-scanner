/**
 * 本日photo取込した行と既存行の重複疑いレポート（読み取り専用）。
 * 実行: cd <repo> && POSTGRES_URL=... npx tsx <this file>
 */
import { db } from "../src/lib/db";
import { transactions } from "../src/lib/db/schema";
import { sql } from "drizzle-orm";

async function main() {
  const rows = await db.execute(sql`
    SELECT t.id, t.vendor, t.amount, t.date, t.bucket, t.status, t.created_at,
           o.id AS dup_id, o.vendor AS dup_vendor, o.source AS dup_source,
           o.status AS dup_status, o.created_at AS dup_created
    FROM transactions t
    JOIN transactions o
      ON o.id <> t.id
     AND o.created_at < t.created_at
     AND o.status <> 'rejected'
     AND o.amount = t.amount
     AND o.date = t.date
     AND t.amount > 0
    WHERE t.source = 'photo'
      AND t.created_at > now() - interval '12 hours'
      AND t.status <> 'rejected'
    ORDER BY t.created_at
  `);
  const list = (rows as unknown as { rows?: unknown[] }).rows ?? rows;
  console.log(JSON.stringify(list, null, 1));

  const cnt = await db.execute(sql`
    SELECT count(*) AS new_photos,
           count(*) FILTER (WHERE amount = 0) AS zero_amount,
           count(*) FILTER (WHERE date IS NULL) AS no_date
    FROM transactions
    WHERE source = 'photo' AND created_at > now() - interval '12 hours'
      AND status <> 'rejected'
  `);
  console.log("SUMMARY:", JSON.stringify((cnt as unknown as { rows?: unknown[] }).rows ?? cnt));
}
main().then(() => process.exit(0));
