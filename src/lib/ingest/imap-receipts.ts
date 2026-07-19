/**
 * IMAP取込 — Gmail APIで読めないメールボックス（efg@nagi-inc.jp = 自社サーバ等）を巡回する。
 * アライブ株式会社のサーバー費用領収書のように、Gmailに転送されないメールをここで拾う。
 *
 * env:
 *   IMAP_ACCOUNTS="nagi"
 *   IMAP_CREDENTIALS_NAGI='{"host":"...","port":993,"user":"...","password":"...",
 *                           "folders":["INBOX","INBOX.Archive"],"senders":["alive-web.co.jp"]}'
 *
 * - senders を指定するとその送信元のみ検索（コスト・誤爆防止のためallowlist運用を推奨）
 * - dedup は Message-ID ベース（ingest_log の account="imap:<name>" と併用）
 * - メール本体の処理は Gmail と同じ processIncoming に委譲（一括PDF・サブスク突合・除外も共通）
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db } from "@/lib/db";
import { ingestLog } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { processIncoming, type IngestSummary } from "./email-receipts";
import type { ParsedMessage } from "./gmail-client";

interface ImapAccountConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  folders?: string[];
  senders?: string[];
}

export function listImapAccounts(): { name: string; cfg: ImapAccountConfig }[] {
  const names = (process.env.IMAP_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: { name: string; cfg: ImapAccountConfig }[] = [];
  for (const name of names) {
    const raw = process.env[`IMAP_CREDENTIALS_${name.toUpperCase()}`];
    if (!raw) continue;
    try {
      const cfg = JSON.parse(raw) as ImapAccountConfig;
      if (cfg.host && cfg.user && cfg.password) out.push({ name, cfg });
    } catch {
      // 壊れたJSONはスキップ
    }
  }
  return out;
}

async function alreadyLogged(account: string, messageId: string): Promise<boolean> {
  const rows = await db
    .select({ id: ingestLog.id })
    .from(ingestLog)
    .where(and(eq(ingestLog.account, account), eq(ingestLog.messageId, messageId)))
    .limit(1);
  return rows.length > 0;
}

export interface ImapIngestOptions {
  newerThanDays?: number;
  maxPerAccount?: number;
  deadlineMs?: number;
}

export async function runImapIngest(
  opts: ImapIngestOptions = {}
): Promise<IngestSummary> {
  const summary: IngestSummary = {
    processed: 0,
    imported: 0,
    matchedRecurring: 0,
    skippedNotReceipt: 0,
    skippedDuplicate: 0,
    deferred: 0,
    timedOut: false,
    errors: [],
    accountErrors: [],
  };
  const days = opts.newerThanDays ?? 3;
  const maxPerAccount = opts.maxPerAccount ?? 25;
  const deadline = opts.deadlineMs ?? Number.POSITIVE_INFINITY;
  const since = new Date(Date.now() - days * 86400_000);

  for (const { name, cfg } of listImapAccounts()) {
    if (Date.now() > deadline) {
      summary.timedOut = true;
      break;
    }
    const acctKey = `imap:${name}`;
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port ?? 993,
      secure: true,
      auth: { user: cfg.user, pass: cfg.password },
      logger: false,
    });
    try {
      await client.connect();
      let handled = 0;
      for (const folder of cfg.folders ?? ["INBOX"]) {
        if (handled >= maxPerAccount || Date.now() > deadline) break;
        const lock = await client.getMailboxLock(folder);
        try {
          for (const sender of cfg.senders ?? [""]) {
            if (handled >= maxPerAccount || Date.now() > deadline) break;
            const criteria: Record<string, unknown> = { since };
            if (sender) criteria.from = sender;
            const uids = (await client.search(criteria, { uid: true })) || [];
            for (const uid of uids) {
              if (handled >= maxPerAccount) {
                summary.deferred++;
                continue;
              }
              if (Date.now() > deadline) {
                summary.timedOut = true;
                summary.deferred++;
                continue;
              }
              try {
                const meta = await client.fetchOne(
                  String(uid),
                  { envelope: true },
                  { uid: true }
                );
                const mid =
                  (meta && meta.envelope?.messageId) || `${folder}:uid${uid}`;
                if (await alreadyLogged(acctKey, mid)) {
                  summary.skippedDuplicate++;
                  continue;
                }
                const dl = await client.download(String(uid), undefined, {
                  uid: true,
                });
                const chunks: Buffer[] = [];
                for await (const chunk of dl.content) {
                  chunks.push(Buffer.from(chunk));
                }
                const parsed = await simpleParser(Buffer.concat(chunks));
                const attachments = (parsed.attachments ?? []).map((a, i) => ({
                  filename: a.filename ?? `attachment-${i}`,
                  mimeType: a.contentType ?? "application/octet-stream",
                  attachmentId: String(i),
                  size: a.size ?? a.content.length,
                }));
                const pm: ParsedMessage = {
                  messageId: mid,
                  subject: parsed.subject ?? "",
                  from: parsed.from?.text ?? "",
                  dateHeader: "",
                  internalDate: parsed.date ?? new Date(),
                  bodyText: (parsed.text ?? "").slice(0, 20000),
                  attachments,
                };
                await processIncoming(
                  acctKey,
                  pm,
                  async (attachmentId) =>
                    (parsed.attachments ?? [])[Number(attachmentId)].content,
                  summary
                );
                summary.processed++;
                handled++;
              } catch (e) {
                summary.errors.push({
                  account: acctKey,
                  messageId: `${folder}:uid${uid}`,
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }
          }
        } finally {
          lock.release();
        }
      }
      await client.logout();
    } catch (e) {
      summary.accountErrors.push({
        account: acctKey,
        error: e instanceof Error ? e.message : String(e),
      });
      try {
        client.close();
      } catch {
        // already closed
      }
    }
  }
  return summary;
}
