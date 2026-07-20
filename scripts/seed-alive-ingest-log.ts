/**
 * 手動取込済みのアライブ月次メール6通を ingest_log に記録し、
 * IMAP自動取込での再取込（重複計上）を防ぐ一回きりのシード。
 * 実行: POSTGRES_URL=... npx tsx scripts/seed-alive-ingest-log.ts <mids.json>
 */
import fs from "fs";
import { db } from "../src/lib/db";
import { ingestLog } from "../src/lib/db/schema";

async function main() {
  const rows = JSON.parse(fs.readFileSync(process.argv[2], "utf-8")) as {
    uid: string;
    mid: string;
    subject: string;
  }[];
  for (const r of rows) {
    if (!r.mid) continue;
    await db
      .insert(ingestLog)
      .values({
        account: "imap:nagi",
        messageId: r.mid,
        subject: r.subject,
        fromAddress: "r.ishikawa@alive-web.co.jp",
        outcome: "imported",
        transactionId: null,
        detail: "手動取込済み（scripts/insert-alive-server.ts 2026-07-12）のためシード",
      })
      .onConflictDoNothing();
    console.log("seeded:", r.uid, r.mid.slice(0, 40));
  }
}
main().then(() => process.exit(0));
