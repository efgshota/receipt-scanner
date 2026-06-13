/**
 * 一時的なDB状態確認スクリプト。トランザクションの全体像を把握する。
 */
import fs from "fs";
import path from "path";

const envPath = path.join(process.cwd(), ".env");
const envContent = fs.readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const [key, ...vals] = line.split("=");
  if (key && vals.length) process.env[key.trim()] = vals.join("=").trim();
}

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.POSTGRES_URL!);

async function main() {
  const total = await sql`SELECT COUNT(*)::int AS n FROM transactions`;
  console.log("=== TOTAL ===");
  console.log(total[0].n, "transactions\n");

  console.log("=== BY STATUS ===");
  const byStatus = await sql`
    SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::int AS total
    FROM transactions GROUP BY status ORDER BY n DESC`;
  for (const r of byStatus) console.log(`  ${r.status.padEnd(12)} ${String(r.n).padStart(4)}件  ¥${Number(r.total).toLocaleString()}`);

  console.log("\n=== BY BUCKET ===");
  const byBucket = await sql`
    SELECT COALESCE(bucket::text,'(null)') AS bucket, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::int AS total
    FROM transactions GROUP BY bucket ORDER BY n DESC`;
  for (const r of byBucket) console.log(`  ${r.bucket.padEnd(12)} ${String(r.n).padStart(4)}件  ¥${Number(r.total).toLocaleString()}`);

  console.log("\n=== BY SOURCE ===");
  const bySource = await sql`
    SELECT source, COUNT(*)::int AS n FROM transactions GROUP BY source ORDER BY n DESC`;
  for (const r of bySource) console.log(`  ${r.source.padEnd(12)} ${String(r.n).padStart(4)}件`);

  console.log("\n=== BUCKET x STATUS ===");
  const cross = await sql`
    SELECT COALESCE(bucket::text,'(null)') AS bucket, status, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::int AS total
    FROM transactions GROUP BY bucket, status ORDER BY bucket, status`;
  for (const r of cross) console.log(`  ${r.bucket.padEnd(10)} ${r.status.padEnd(12)} ${String(r.n).padStart(4)}件  ¥${Number(r.total).toLocaleString()}`);

  console.log("\n=== DATE RANGE ===");
  const dates = await sql`
    SELECT MIN(date) AS min_date, MAX(date) AS max_date, COUNT(*) FILTER (WHERE date IS NULL)::int AS null_dates
    FROM transactions`;
  console.log(`  ${dates[0].min_date} 〜 ${dates[0].max_date}  (日付null: ${dates[0].null_dates}件)`);

  console.log("\n=== RECEIPT IMAGE ===");
  const imgs = await sql`
    SELECT COUNT(*) FILTER (WHERE receipt_image_url IS NOT NULL)::int AS with_img,
           COUNT(*) FILTER (WHERE receipt_image_url IS NULL)::int AS without_img
    FROM transactions`;
  console.log(`  画像あり: ${imgs[0].with_img}件 / 画像なし: ${imgs[0].without_img}件`);

  console.log("\n=== MF SUBMITTED (mf_transaction_id) ===");
  const mf = await sql`
    SELECT COUNT(*) FILTER (WHERE mf_transaction_id IS NOT NULL)::int AS submitted,
           COUNT(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS has_submitted_at
    FROM transactions`;
  console.log(`  mf_transaction_id あり: ${mf[0].submitted}件 / submitted_at あり: ${mf[0].has_submitted_at}件`);

  // 月別 x バケツ（精算単位の目安）
  console.log("\n=== 月別 x バケツ ===");
  const monthly = await sql`
    SELECT to_char(date,'YYYY-MM') AS ym, COALESCE(bucket::text,'(null)') AS bucket,
           COUNT(*)::int AS n, COALESCE(SUM(amount),0)::int AS total
    FROM transactions WHERE date IS NOT NULL
    GROUP BY ym, bucket ORDER BY ym, bucket`;
  for (const r of monthly) console.log(`  ${r.ym}  ${r.bucket.padEnd(10)} ${String(r.n).padStart(3)}件  ¥${Number(r.total).toLocaleString()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
