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
} from "drizzle-orm/pg-core";

export const bucketEnum = pgEnum("bucket", ["nagi", "stadiums", "family"]);

export const sourceEnum = pgEnum("source", ["gmail", "mfme", "photo"]);

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
