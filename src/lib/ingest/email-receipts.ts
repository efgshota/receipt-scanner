import { db } from "@/lib/db";
import { ingestLog, transactions } from "@/lib/db/schema";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import {
  listGmailAccounts,
  getGmailAccessToken,
  searchMessageIds,
  getMessage,
  getAttachment,
  type GmailAccount,
  type ParsedMessage,
} from "./gmail-client";
import { extractReceiptFromEmail } from "./extract";
import { classify } from "@/lib/classification/engine";
import {
  matchRecurringRule,
  findGeneratedTransaction,
  amountWithinTolerance,
  monthKey,
} from "@/lib/recurring/engine";
import { raiseAlert } from "@/lib/integrations/token-store";

/**
 * Gmail領収書 自動取込パイプライン。
 *
 * 冪等性: ingest_log の (account, message_id) ユニーク制約 + transactions.sourceId
 * の二重チェックで、cronの重複発火・再実行でも二重取込しない。
 * 検索窓 newer_than:Nd はcron失敗時の自己修復のため実行間隔より広くとる。
 */

// 注意: Gmail検索の {} はOR結合演算子。ANDは並置で表現する（{}で囲むと全メールにマッチするバグになる）
const DEFAULT_QUERY_TERMS =
  "subject:(領収書 OR 領収証 OR レシート OR receipt OR invoice OR 請求 OR ご利用明細 OR 決済 OR payment) -from:me";
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// 取込除外（本人の精算対象外と指示されたもの）。From/件名/抽出ベンダー名に
// 部分一致（小文字比較）でスキップ。env INGEST_EXCLUDE_PATTERNS で追加可能。
// - Meta広告: 本人が精算することはない（2026-07-11 指示。再開時は連絡が来る）
const DEFAULT_EXCLUDE_PATTERNS = [
  "facebook.com", // noreply@business-updates.facebook.com 等のMeta系送信元
  "facebookmail",
  "meta広告",
  "meta for business",
];

function excludePatterns(): string[] {
  const extra = (process.env.INGEST_EXCLUDE_PATTERNS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_EXCLUDE_PATTERNS, ...extra];
}

function matchesExclude(text: string): string | null {
  const t = text.toLowerCase();
  return excludePatterns().find((p) => t.includes(p)) ?? null;
}

export interface IngestOptions {
  accounts?: string[]; // 未指定なら env の全アカウント
  newerThanDays?: number; // デフォルト3日（日次cron+自己修復マージン）
  maxPerAccount?: number; // 1回の実行あたり処理上限（cronの時間枠保護）
  deadlineMs?: number; // この時刻(epoch ms)を過ぎたら新規処理を止める（Vercel maxDuration保護）
  queryTerms?: string; // 検索語の上書き（過去分バックフィル等でベンダーを絞る用途）
}

export interface IngestSummary {
  processed: number;
  imported: number;
  matchedRecurring: number;
  skippedNotReceipt: number;
  skippedDuplicate: number;
  deferred: number; // 上限/時間切れで次回実行に持ち越した件数（dedupではない）
  timedOut: boolean;
  errors: { account: string; messageId: string; error: string }[];
  accountErrors: { account: string; error: string }[];
}

function buildQuery(days: number, override?: string): string {
  const custom = override ?? process.env.GMAIL_INGEST_QUERY;
  const terms = custom ?? DEFAULT_QUERY_TERMS;
  return `${terms} newer_than:${days}d -in:spam -in:trash`;
}

async function alreadyLogged(
  account: string,
  messageIds: string[]
): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await db
    .select({ messageId: ingestLog.messageId })
    .from(ingestLog)
    .where(
      and(
        eq(ingestLog.account, account),
        inArray(ingestLog.messageId, messageIds)
      )
    );
  return new Set(rows.map((r) => r.messageId));
}

async function logOutcome(
  account: string,
  msg: ParsedMessage,
  outcome: string,
  transactionId: string | null,
  detail: string
): Promise<void> {
  try {
    await db
      .insert(ingestLog)
      .values({
        account,
        messageId: msg.messageId,
        subject: msg.subject.slice(0, 300),
        fromAddress: msg.from.slice(0, 300),
        outcome,
        transactionId,
        detail: detail.slice(0, 500),
      })
      .onConflictDoNothing();
  } catch {
    // ログ失敗は本処理を止めない
  }
}

/**
 * 添付をVercel Blob（なければローカルpublic/uploads）へ保存しURLを返す。
 * 注: BlobのURLは推測困難なランダムパスの公開URL（Basic認証の外）。
 * URL漏洩時は証憑が閲覧可能になるトレードオフを許容している（厳密化する場合は
 * private Blob + 認証付きプロキシ配信に変更）。
 */
let blobMissingAlerted = false;
async function storeAttachment(
  account: string,
  messageId: string,
  filename: string,
  buf: Buffer,
  contentType: string
): Promise<string | null> {
  try {
    // Vercel上でBlobトークンが無いとfsは揮発し証憑が無言で消えるため一度だけ警告
    if (process.env.VERCEL && !process.env.BLOB_READ_WRITE_TOKEN) {
      if (!blobMissingAlerted) {
        blobMissingAlerted = true;
        await raiseAlert(
          "ingest_error",
          "BLOB_READ_WRITE_TOKEN未設定のため証憑を永続保存できません（添付なしで取込継続中）"
        );
      }
      return null;
    }
    const safeName = `email-${account}-${messageId.slice(0, 12)}-${filename.replace(/[^\w.\-]/g, "_")}`;
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const { put } = await import("@vercel/blob");
      const blob = await put(`receipts/${safeName}`, buf, {
        access: "public",
        contentType,
      });
      return blob.url;
    }
    const fs = await import("fs");
    const path = await import("path");
    const dir = path.join(process.cwd(), "public/uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safeName), buf);
    return `/uploads/${safeName}`;
  } catch {
    return null; // 保存失敗でも取込自体は続行（証憑なし）
  }
}

async function processMessage(
  account: GmailAccount,
  accessToken: string,
  messageId: string,
  summary: IngestSummary
): Promise<void> {
  const msg = await getMessage(accessToken, messageId);

  // 除外リスト: Claude呼び出し前に送信元/件名で弾く（APIコストもゼロ）
  const excludedBy = matchesExclude(`${msg.from} ${msg.subject}`);
  if (excludedBy) {
    summary.skippedNotReceipt++;
    await logOutcome(
      account.name,
      msg,
      "skipped_excluded",
      null,
      `除外パターン: ${excludedBy}`
    );
    return;
  }

  // 添付選定: PDF優先、次に画像
  const pdf = msg.attachments.find(
    (a) => a.mimeType === "application/pdf" && a.size <= MAX_ATTACHMENT_BYTES
  );
  const image = pdf
    ? undefined
    : msg.attachments.find(
        (a) => a.mimeType.startsWith("image/") && a.size <= MAX_ATTACHMENT_BYTES
      );

  let pdfBuf: Buffer | null = null;
  let imageBuf: Buffer | null = null;
  if (pdf) {
    pdfBuf = await getAttachment(accessToken, messageId, pdf.attachmentId);
  } else if (image) {
    imageBuf = await getAttachment(accessToken, messageId, image.attachmentId);
  }

  const extraction = await extractReceiptFromEmail({
    subject: msg.subject,
    from: msg.from,
    bodyText: msg.bodyText,
    pdfBase64: pdfBuf?.toString("base64") ?? null,
    imageBase64: imageBuf?.toString("base64") ?? null,
    imageMediaType: image?.mimeType ?? null,
  });

  if (!extraction.isReceipt) {
    summary.skippedNotReceipt++;
    await logOutcome(
      account.name,
      msg,
      "skipped_not_receipt",
      null,
      extraction.reasoning
    );
    return;
  }

  // 除外バックストップ: 送信元が変わっても抽出ベンダー名で弾く
  const excludedVendor = matchesExclude(extraction.vendor);
  if (excludedVendor) {
    summary.skippedNotReceipt++;
    await logOutcome(
      account.name,
      msg,
      "skipped_excluded",
      null,
      `除外パターン(vendor): ${excludedVendor}`
    );
    return;
  }

  // 証憑保存
  let receiptImageUrl: string | null = null;
  if (pdfBuf && pdf) {
    receiptImageUrl = await storeAttachment(
      account.name,
      messageId,
      pdf.filename,
      pdfBuf,
      "application/pdf"
    );
  } else if (imageBuf && image) {
    receiptImageUrl = await storeAttachment(
      account.name,
      messageId,
      image.filename,
      imageBuf,
      image.mimeType
    );
  }

  const sourceId = `${account.name}:${messageId}`;
  const txDate =
    extraction.date ||
    msg.internalDate.toISOString().slice(0, 10); // 抽出失敗時はメール受信日

  // ---- サブスク突合 ----
  const rule = await matchRecurringRule(extraction.vendor);
  if (rule) {
    const mk = monthKey(new Date(txDate));
    const generated = await findGeneratedTransaction(rule.id, mk);
    const within =
      extraction.amount > 0 && amountWithinTolerance(rule, extraction.amount);

    // 既にメール紐付け済みの生成行がある場合（どのアカウント由来でも）:
    // 同月2通目（請求書+支払完了ペア・再送等）は重複作成せずスキップして目視可能にする
    if (generated && generated.sourceId) {
      summary.skippedDuplicate++;
      await logOutcome(
        account.name,
        msg,
        "skipped_already_linked",
        generated.id,
        `rule=${rule.name} 既存リンク=${generated.sourceId.slice(0, 30)}`
      );
      return;
    }

    if (generated && !generated.sourceId) {
      // 自動生成済み行に実領収書を紐付け（提出済みなら金額・状態は触らない）
      const locked =
        generated.status === "submitted" || generated.status === "attached";
      await db
        .update(transactions)
        .set({
          sourceId,
          receiptImageUrl: receiptImageUrl ?? generated.receiptImageUrl,
          invoiceNumber: extraction.invoiceNumber ?? generated.invoiceNumber,
          ocrRaw: { email: { subject: msg.subject, from: msg.from }, extraction },
          ...(locked
            ? {}
            : within
              ? { amount: extraction.amount, confidence: 1.0 }
              : {
                  amount: extraction.amount || generated.amount,
                  status: "pending" as const,
                  classificationReason: `⚠ サブスク金額変動: 予定¥${rule.expectedAmount} → 実際¥${extraction.amount}`,
                }),
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, generated.id));
      summary.matchedRecurring++;
      await logOutcome(
        account.name,
        msg,
        "matched_recurring",
        generated.id,
        `rule=${rule.name} within=${within}`
      );
      return;
    }

    // 生成前にメールが来た場合: ルール情報で直接作成（生成フェーズは冪等ガードでスキップされる）
    const [inserted] = await db
      .insert(transactions)
      .values({
        source: "gmail",
        sourceId,
        vendor: extraction.vendor,
        amount: extraction.amount,
        date: txDate,
        description: extraction.description,
        invoiceNumber: extraction.invoiceNumber,
        receiptImageUrl,
        ocrRaw: { email: { subject: msg.subject, from: msg.from }, extraction },
        bucket: rule.bucket,
        confidence: 1.0,
        classificationReason: `recurring_rule: ${rule.name}（メール取込）`,
        status: within ? (rule.autoSubmit ? "approved" : "classified") : "pending",
        recurringRuleId: rule.id,
      })
      .returning();
    summary.matchedRecurring++;
    await logOutcome(
      account.name,
      msg,
      "matched_recurring",
      inserted.id,
      `rule=${rule.name} created_before_generation`
    );
    return;
  }

  // ---- 通常取込（分類エンジン） ----
  const classification = await classify({
    vendor: extraction.vendor,
    amount: extraction.amount,
    date: txDate,
    description: extraction.description,
  });

  // 同一金額・近接日の既存取引があれば重複疑い（同じ課金の領収書+支払完了メールペア対策）
  let dupSuspect = false;
  if (extraction.amount > 0) {
    const d = new Date(txDate);
    const lo = new Date(d.getTime() - 3 * 86400_000).toISOString().slice(0, 10);
    const hi = new Date(d.getTime() + 3 * 86400_000).toISOString().slice(0, 10);
    const similar = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.amount, extraction.amount),
          gte(transactions.date, lo),
          lte(transactions.date, hi)
        )
      );
    dupSuspect = similar.length > 0;
  }

  const needsReview =
    extraction.amount <= 0 || classification.confidence < 0.85 || dupSuspect;

  const [inserted] = await db
    .insert(transactions)
    .values({
      source: "gmail",
      sourceId,
      vendor: extraction.vendor,
      amount: extraction.amount,
      date: txDate,
      description: extraction.description,
      invoiceNumber: extraction.invoiceNumber,
      receiptImageUrl,
      ocrRaw: { email: { subject: msg.subject, from: msg.from }, extraction },
      bucket: classification.bucket,
      confidence: classification.confidence,
      classificationReason: `${classification.reason}（メール取込: ${extraction.reasoning}）${dupSuspect ? " | ⚠ 同額の取引あり・重複疑い" : ""}`,
      status: needsReview ? "pending" : "classified",
    })
    .returning();

  summary.imported++;
  await logOutcome(account.name, msg, "imported", inserted.id, extraction.reasoning);
}

export async function runEmailIngest(
  opts: IngestOptions = {}
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

  const all = listGmailAccounts();
  const accounts = opts.accounts
    ? all.filter((a) => opts.accounts!.includes(a.name))
    : all;
  const days = opts.newerThanDays ?? 3;
  const maxPerAccount = opts.maxPerAccount ?? 25;
  const query = buildQuery(days, opts.queryTerms);

  const deadline = opts.deadlineMs ?? Number.POSITIVE_INFINITY;

  for (const account of accounts) {
    if (Date.now() > deadline) {
      summary.timedOut = true;
      break;
    }
    try {
      const accessToken = await getGmailAccessToken(account);
      const ids = await searchMessageIds(accessToken, query, maxPerAccount * 2);
      const logged = await alreadyLogged(account.name, ids);
      const notLogged = ids.filter((id) => !logged.has(id));
      const fresh = notLogged.slice(0, maxPerAccount);
      summary.skippedDuplicate += ids.length - notLogged.length;
      summary.deferred += notLogged.length - fresh.length;

      for (const id of fresh) {
        // 時間切れ: 未処理分は次回のnewer_than窓+dedupで自動的に拾われる
        if (Date.now() > deadline) {
          summary.timedOut = true;
          summary.deferred += fresh.length - fresh.indexOf(id);
          break;
        }
        try {
          // transactions.sourceId の二重チェック（ingest_log消失時の保険）
          const dup = await db
            .select({ id: transactions.id })
            .from(transactions)
            .where(eq(transactions.sourceId, `${account.name}:${id}`));
          if (dup.length > 0) {
            summary.skippedDuplicate++;
            continue;
          }
          await processMessage(account, accessToken, id, summary);
          summary.processed++;
        } catch (e) {
          summary.errors.push({
            account: account.name,
            messageId: id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      summary.accountErrors.push({ account: account.name, error });
      // invalid_grant = refresh_token失効（パスワード変更等）。ダッシュボードに通知
      if (error.includes("invalid_grant") || error.includes("401")) {
        await raiseAlert(
          "token_expired",
          `Gmail (${account.name}) の認証が失効しています。再認証が必要です`
        );
      }
    }
  }
  return summary;
}
