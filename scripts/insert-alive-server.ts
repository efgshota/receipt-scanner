/**
 * アライブ株式会社のサーバー月額費用（efg@nagi-inc.jp のIMAP経由で受領）を取込む一回きりのスクリプト。
 * 証憑PDFは事前に public/uploads/ に配置しておく（実行後にBlob移行スクリプトで移す）。
 * 実行: POSTGRES_URL=... npx tsx scripts/insert-alive-server.ts
 */
import { db } from "../src/lib/db";
import { transactions } from "../src/lib/db/schema";
import { and, eq } from "drizzle-orm";

const COMMON = {
  source: "gmail" as const, // IMAP経由のメール受領（gmail-multiと同じメール系ソースとして扱う）
  vendor: "アライブ株式会社",
  amount: 17600,
  bucket: "nagi" as const,
  confidence: 1.0,
  invoiceNumber: "T9180001057352",
};

const ROWS = [
  {
    date: "2026-03-25",
    description: "Nagiサーバ月額費用 2026年2月分（領収書INV-00015440）",
    sourceId: "imap:nagi:INV-00015055-r15440",
    receiptImageUrl: "/uploads/alive-receipt-202602-INV-00015440.pdf",
    status: "classified" as const,
    reason: "アライブ月次サーバー費用（IMAP: 2/25受領メールの領収書）",
  },
  {
    date: "2026-04-24",
    description:
      "Nagiサーバ月額費用 2026年3月分（領収書INV-00015721 ※但書は2025年3月分と年誤記）",
    sourceId: "imap:nagi:INV-00015721",
    receiptImageUrl: "/uploads/alive-receipt-202603-INV-00015721.pdf",
    status: "classified" as const,
    reason: "アライブ月次サーバー費用（IMAP: 4/27受領メールの領収書）",
  },
  {
    date: "2026-05-25",
    description:
      "Nagiサーバ月額費用 2026年4月分（領収書INV-00016136 ※但書は2025年4月分と年誤記）",
    sourceId: "imap:nagi:INV-00016136",
    receiptImageUrl: "/uploads/alive-receipt-202604-INV-00016136.pdf",
    status: "classified" as const,
    reason: "アライブ月次サーバー費用（IMAP: 5/25受領メールの領収書）",
  },
  {
    date: "2026-06-25",
    description:
      "Nagiサーバ月額費用 2026年5月分（領収書INV-00016484 ※但書は2025年5月分と年誤記）",
    sourceId: "imap:nagi:INV-00016484",
    receiptImageUrl: "/uploads/alive-receipt-202605-INV-00016484.pdf",
    status: "classified" as const,
    reason: "アライブ月次サーバー費用（IMAP: 6/25受領メールの領収書）",
  },
  {
    date: "2026-06-30",
    description:
      "Nagiサーバ月額費用 2026年6月分（請求書INV-00016790・支払期限2026/7/25・領収書未着）",
    sourceId: "imap:nagi:INV-00016790",
    receiptImageUrl: "/uploads/alive-invoice-202606-INV-00016790.pdf",
    status: "pending" as const,
    reason: "⚠ 6月分は請求書段階（未払の可能性・領収書が来たら差し替え）",
  },
];

async function main() {
  for (const r of ROWS) {
    const [dup] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.sourceId, r.sourceId)));
    if (dup) {
      console.log(`skip (exists): ${r.sourceId}`);
      continue;
    }
    const [ins] = await db
      .insert(transactions)
      .values({
        ...COMMON,
        date: r.date,
        description: r.description,
        sourceId: r.sourceId,
        receiptImageUrl: r.receiptImageUrl,
        status: r.status,
        classificationReason: r.reason,
        ocrRaw: { manualImport: "alive-imap-2026-07-12" },
      })
      .returning();
    console.log(`inserted: ${ins.id.slice(0, 8)} ${r.date} ${r.description.slice(0, 40)}`);
  }
  console.log("done");
}

main().then(() => process.exit(0));
