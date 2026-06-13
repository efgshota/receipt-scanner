/**
 * MoneyForward家族精算項目をDBに一括登録するスクリプト。
 * source: "mfme", receiptImageUrl: null で登録し、
 * 後からレシート写真と突合する。
 */

import fs from "fs";
import path from "path";

// Load .env manually
const envPath = path.join(process.cwd(), ".env");
const envContent = fs.readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const [key, ...vals] = line.split("=");
  if (key && vals.length) process.env[key.trim()] = vals.join("=").trim();
}

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { transactions } from "../src/lib/db/schema";

const sql = neon(process.env.POSTGRES_URL!);
const db = drizzle(sql);

const items = [
  // February
  { date: "2026-02-01", vendor: "バス（都電/東急）", amount: 450, desc: "交通費" },
  { date: "2026-02-03", vendor: "物販", amount: 2500, desc: "" },
  { date: "2026-02-04", vendor: "Rocket Now", amount: 3800, desc: "" },
  { date: "2026-02-07", vendor: "物販", amount: 2316, desc: "2件" },
  { date: "2026-02-08", vendor: "三越伊勢丹", amount: 2099, desc: "三越伊勢丹+物販" },
  { date: "2026-02-11", vendor: "GOアプリ", amount: 2200, desc: "タクシー（駒沢方面）" },
  { date: "2026-02-11", vendor: "コンビニ等", amount: 2840, desc: "QPP+ローソン" },
  { date: "2026-02-11", vendor: "千代の湯", amount: 500, desc: "銭湯" },
  { date: "2026-02-14", vendor: "ローソン", amount: 390, desc: "" },
  { date: "2026-02-18", vendor: "鍋え蔵", amount: 2640, desc: "渋谷" },
  { date: "2026-02-20", vendor: "ETC 東日本高速", amount: 840, desc: "高速道路（2件）" },
  { date: "2026-02-21", vendor: "GOアプリ", amount: 900, desc: "タクシー（港区）" },
  { date: "2026-02-22", vendor: "鶏太家宅配+車検税金", amount: 46620, desc: "宅配+車検税金" },
  { date: "2026-02-25", vendor: "ローソン", amount: 1213, desc: "" },
  // March
  { date: "2026-03-01", vendor: "ETC 中日本高速", amount: 2180, desc: "高速道路（2件）+首都高特割+首都高" },
  { date: "2026-03-02", vendor: "クイックペイプラス", amount: 1815, desc: "2件" },
  { date: "2026-03-05", vendor: "ETC 東日本高速", amount: 1900, desc: "高速道路（2件）+QPP" },
  { date: "2026-03-07", vendor: "ETC 首都高速", amount: 380, desc: "首都高速" },
  { date: "2026-03-11", vendor: "クイックペイプラス", amount: 390, desc: "" },
  { date: "2026-03-13", vendor: "BMW MINI 東京 六本木", amount: 19880, desc: "" },
  { date: "2026-03-14", vendor: "ETC 首都高速", amount: 690, desc: "首都高速" },
  { date: "2026-03-14", vendor: "TONA", amount: 1530, desc: "2件" },
  { date: "2026-03-15", vendor: "コミュニティサイクル", amount: 1650, desc: "" },
  { date: "2026-03-21", vendor: "ETC 首都高速", amount: 1410, desc: "首都高速（3件）" },
  { date: "2026-03-22", vendor: "JS/STREAMER CC 中目黒", amount: 900, desc: "" },
  { date: "2026-03-22", vendor: "目黒川ロータス/AIR", amount: 770, desc: "" },
  { date: "2026-03-29", vendor: "ANA コールセンター", amount: 8200, desc: "2件" },
];

async function main() {
  console.log(`Inserting ${items.length} MoneyForward family items...`);

  for (const item of items) {
    const [inserted] = await db
      .insert(transactions)
      .values({
        source: "mfme",
        vendor: item.vendor,
        amount: item.amount,
        date: item.date,
        description: item.desc,
        bucket: "family",
        confidence: 1.0,
        classificationReason: "mf-family",
        status: "classified",
        receiptImageUrl: null,
      })
      .returning();

    console.log(`  ✓ ${item.date} ${item.vendor} ¥${item.amount} [${inserted.id.slice(0, 8)}]`);
  }

  console.log(`\nDone: ${items.length} items inserted`);
}

main().catch(console.error);
