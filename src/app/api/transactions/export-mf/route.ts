import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { asc, eq, and, gte, lte, type SQL } from "drizzle-orm";
import type { TransactionStatus, Bucket } from "@/lib/types";

/**
 * MFクラウド会計「仕訳帳インポート」形式のCSVを出力する。
 * NAGIの経費内製化用: 本人立替の領収書 → 借方=経費科目 / 貸方=役員借入金 の単一仕訳。
 * 列構成はMF会計のサンプルフォーマット準拠（1行目のラベルは変更不可）。
 * 取込手順: MF会計 → 会計帳簿 → 仕訳帳 → インポート → 仕訳帳
 */

const HEADERS = [
  "取引No",
  "取引日",
  "借方勘定科目",
  "借方補助科目",
  "借方部門",
  "借方取引先",
  "借方税区分",
  "借方インボイス",
  "借方金額(円)",
  "借方税額",
  "貸方勘定科目",
  "貸方補助科目",
  "貸方部門",
  "貸方取引先",
  "貸方税区分",
  "貸方インボイス",
  "貸方金額(円)",
  "貸方税額",
  "摘要",
  "仕訳メモ",
  "タグ",
  "MF仕訳タイプ",
  "決算整理仕訳",
  "作成日時",
  "作成者",
  "最終更新日時",
  "最終更新者",
];

// キーワード → 勘定科目の自動マッピング（判定不能は雑費＋要確認メモ）
const ACCOUNT_RULES: { pattern: RegExp; account: string }[] = [
  {
    pattern:
      /駐車|パーキング|PARKING|タクシー|交通|GO Pay|^GO$|高速|ETC|鉄道|新幹線|航空|バス|WiFi|Suica|PASMO/i,
    account: "旅費交通費",
  },
  {
    pattern:
      /Vercel|Figma|Anthropic|Adobe|GitHub|Notion|microCMS|Cloudflare|Neon|OpenAI|Google Workspace|サブスク|ドメイン|サーバ|SaaS/i,
    account: "通信費",
  },
  { pattern: /書籍|新聞|Kindle|BOOK/i, account: "新聞図書費" },
  {
    pattern: /飲食|カフェ|コーヒー|COFFEE|CAFE|レストラン|スターバックス|Bar|食堂|弁当/i,
    account: "会議費",
  },
  { pattern: /カメラ|機材|工具|器具|家電|Amazon|ヨドバシ|ビックカメラ/i, account: "消耗品費" },
];

function mapAccount(vendor: string, description: string): {
  account: string;
  needsReview: boolean;
} {
  const text = `${vendor} ${description}`;
  for (const r of ACCOUNT_RULES) {
    if (r.pattern.test(text)) return { account: r.account, needsReview: false };
  }
  return { account: "雑費", needsReview: true };
}

const FORMULA = /^[=+\-@\t\r]/;
function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v !== "number" && FORMULA.test(s)) s = "'" + s;
  s = s.replace(/"/g, '""');
  return /[",\n\r]/.test(s) ? `"${s}"` : s;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const bucket = (searchParams.get("bucket") ?? "nagi") as Bucket;
  const status = (searchParams.get("status") ?? "approved") as TransactionStatus;
  const credit = searchParams.get("credit") ?? "役員借入金"; // 貸方勘定科目
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const filters: SQL[] = [eq(transactions.bucket, bucket)];
  if (status !== ("all" as string)) filters.push(eq(transactions.status, status));
  if (from) filters.push(gte(transactions.date, from));
  if (to) filters.push(lte(transactions.date, to));

  const rows = await db
    .select()
    .from(transactions)
    .where(and(...filters))
    .orderBy(asc(transactions.date));

  const lines = [HEADERS.join(",")];
  let no = 1;
  const skipped: string[] = [];

  for (const r of rows) {
    if (!r.date || !r.amount) {
      skipped.push(r.id.slice(0, 8));
      continue; // 取引日/金額はMF必須。欠落行は仕訳にできない
    }
    const { account, needsReview } = mapAccount(r.vendor, r.description ?? "");
    const memos: string[] = [`receipt-scanner:${r.id.slice(0, 8)}`];
    if (needsReview) memos.push("勘定科目要確認");
    if (r.amount >= 100000) memos.push("10万円以上・資産計上/少額特例の要否確認");
    if (/飲食|カフェ|コーヒー|COFFEE|CAFE/i.test(`${r.vendor}${r.description ?? ""}`))
      memos.push("軽減税率(8%)該当の可能性あり・税区分確認");

    const cols = [
      no, // 取引No
      r.date.replaceAll("-", "/"), // 取引日 yyyy/MM/dd
      account, // 借方勘定科目
      "", // 借方補助科目
      "", // 借方部門
      "", // 借方取引先
      "課税仕入 10%", // 借方税区分
      r.invoiceNumber ? "適格" : "", // 借方インボイス
      r.amount, // 借方金額(円)
      "", // 借方税額（MF側で自動計算）
      credit, // 貸方勘定科目
      "",
      "",
      "",
      "対象外", // 貸方税区分
      "",
      r.amount, // 貸方金額(円)
      "",
      `${r.vendor}${r.description ? " " + r.description : ""}`.slice(0, 100), // 摘要
      memos.join(" / "), // 仕訳メモ
      "receipt-scanner", // タグ
      "", // MF仕訳タイプ
      "", // 決算整理仕訳
      "",
      "",
      "",
      "",
    ];
    lines.push(cols.map(esc).join(","));
    no++;
  }

  // 末尾にコメント行は入れない（MFはラベル行+データ行のみ想定）。欠落はヘッダで通知
  const csv = "\uFEFF" + lines.join("\r\n");
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="mf_journal_${bucket}_${today}.csv"`,
      "X-Skipped-Rows": skipped.length ? skipped.join(",") : "none",
    },
  });
}
