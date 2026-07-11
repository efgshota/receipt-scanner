import {
  pgTable,
  uuid,
  text,
  integer,
  date,
  real,
  timestamp,
  jsonb,
  pgEnum,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const bucketEnum = pgEnum("bucket", ["nagi", "stadiums", "family"]);

export const sourceEnum = pgEnum("source", ["gmail", "mfme", "photo", "recurring"]);

export const statusEnum = pgEnum("status", [
  "pending",
  "classified",
  "approved",
  "submitted",
  "attached",
  "rejected",
]);

export const ruleTypeEnum = pgEnum("rule_type", [
  "fixed",
  "learned",
  "conditional",
]);

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: sourceEnum("source").notNull(),
  sourceId: text("source_id"),
  vendor: text("vendor").notNull(),
  amount: integer("amount").notNull(),
  date: date("date"),
  description: text("description").notNull().default(""),
  invoiceNumber: text("invoice_number"),
  receiptImageUrl: text("receipt_image_url"),
  ocrRaw: jsonb("ocr_raw"),
  bucket: bucketEnum("bucket"),
  confidence: real("confidence"),
  classificationReason: text("classification_reason"),
  status: statusEnum("status").notNull().default("pending"),
  mfTransactionId: text("mf_transaction_id"),
  submittedAt: timestamp("submitted_at"),
  // サブスク自動計上との突合: このルールから生成/紐付けされた取引
  recurringRuleId: uuid("recurring_rule_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const corrections = pgTable("corrections", {
  id: uuid("id").primaryKey().defaultRandom(),
  transactionId: uuid("transaction_id")
    .notNull()
    .references(() => transactions.id),
  originalBucket: bucketEnum("original_bucket").notNull(),
  correctedBucket: bucketEnum("corrected_bucket").notNull(),
  vendorPattern: text("vendor_pattern").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const vendorRules = pgTable("vendor_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendorPattern: text("vendor_pattern").notNull(),
  bucket: bucketEnum("bucket").notNull(),
  ruleType: ruleTypeEnum("rule_type").notNull(),
  condition: jsonb("condition"),
  confidence: real("confidence").notNull().default(1.0),
  correctionCount: integer("correction_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const calendarCache = pgTable("calendar_cache", {
  date: date("date").primaryKey(),
  calendarsWithEvents: jsonb("calendars_with_events").notNull(),
  fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
});

// ============================================================
// 外部サービスOAuthトークン（Vercelサーバレスではファイル保存不可のためDB保存）
// provider例: "mf_expense:nagi" | "mf_expense:stadiums" | "mf_invoice:nagi"
// ============================================================
export const oauthTokens = pgTable("oauth_tokens", {
  provider: text("provider").primaryKey(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  scope: text("scope"),
  expiresAt: timestamp("expires_at"),
  // office_id / office_member_id 等、接続時に発見した付帯情報
  meta: jsonb("meta"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================================
// サブスク（定期支出）ルール: 月次cronが経費エントリを自動生成し、
// メール取込された実領収書と突合（同ルール・同月・金額が許容範囲内なら紐付け）
// ============================================================
export const recurringRules = pgTable("recurring_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(), // 表示名 例: "Google Workspace (NAGI)"
  vendorPattern: text("vendor_pattern").notNull(), // 受信領収書とのマッチ用（部分一致・大文字小文字無視）
  bucket: bucketEnum("bucket").notNull(),
  expectedAmount: integer("expected_amount").notNull(),
  // 金額変動の許容率。超えたら自動承認せず pending に落として目視へ
  amountTolerance: real("amount_tolerance").notNull().default(0.2),
  dayOfMonth: integer("day_of_month").notNull().default(1), // 生成日
  active: boolean("active").notNull().default(true),
  // true なら承認→MF提出まで全自動（バケツがMF対象の場合）
  autoSubmit: boolean("auto_submit").notNull().default(true),
  lastGeneratedMonth: text("last_generated_month"), // "2026-07"
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================================
// メール取込ログ: 処理済みmessageIdの記録（dedup兼監査）。
// (account, messageId) 一意で再処理を恒久的に防ぐ。
// ============================================================
export const ingestLog = pgTable(
  "ingest_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account: text("account").notNull(), // personal | ttne | stadiums | zapass
    messageId: text("message_id").notNull(),
    subject: text("subject"),
    fromAddress: text("from_address"),
    // imported | skipped_duplicate | skipped_not_receipt | matched_recurring | error
    outcome: text("outcome").notNull(),
    transactionId: uuid("transaction_id"),
    detail: text("detail"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ingest_log_account_message_idx").on(t.account, t.messageId)]
);

// ============================================================
// 請求書・見積書（MFクラウド請求書がドキュメントの実体、ここは統制・遅延防止レイヤー）
// ============================================================
export const invoiceKindEnum = pgEnum("invoice_kind", ["invoice", "quote"]);
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft", // ローカル起票のみ
  "created_in_mf", // MFにドラフト作成済み
  "sent", // 送付済み
  "paid", // 入金確認
  "void", // 取消
]);

export const billingClients = pgTable("billing_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  mfPartnerId: text("mf_partner_id"), // MF請求書の取引先ID
  // 帳票作成APIが要求するのは department_id（partner_id ではない）
  mfDepartmentId: text("mf_department_id"),
  defaultTitle: text("default_title"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// 定期請求スケジュール（毎月の顧問料など）— 月次cronがドラフトを自動起票し、
// 発行期日を過ぎて未発行ならダッシュボードに遅延警告を出す
export const invoiceSchedules = pgTable("invoice_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => billingClients.id),
  title: text("title").notNull(),
  amount: integer("amount").notNull(), // 税抜
  taxRate: real("tax_rate").notNull().default(0.1),
  issueDayOfMonth: integer("issue_day_of_month").notNull().default(25),
  // 支払期日ルール: 例 "end_of_next_month"
  dueRule: text("due_rule").notNull().default("end_of_next_month"),
  items: jsonb("items"), // 明細行テンプレート
  active: boolean("active").notNull().default(true),
  lastGeneratedMonth: text("last_generated_month"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// システムアラート（トークン失効・cron失敗等）。Hobbyのログは1時間で消えるため
// 異常はDBに記録してダッシュボードに赤バナー表示する
export const systemAlerts = pgTable("system_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(), // token_expired | cron_error | ingest_error | invoice_overdue
  message: text("message").notNull(),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: invoiceKindEnum("kind").notNull().default("invoice"),
  status: invoiceStatusEnum("status").notNull().default("draft"),
  clientId: uuid("client_id").references(() => billingClients.id),
  scheduleId: uuid("schedule_id").references(() => invoiceSchedules.id),
  title: text("title").notNull(),
  amount: integer("amount").notNull(), // 税抜
  taxRate: real("tax_rate").notNull().default(0.1),
  issueDate: date("issue_date"),
  dueDate: date("due_date"),
  items: jsonb("items"),
  mfInvoiceId: text("mf_invoice_id"), // MF請求書側のID
  mfPdfUrl: text("mf_pdf_url"),
  memo: text("memo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
