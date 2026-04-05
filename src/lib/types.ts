export type Bucket = "nagi" | "stadiums" | "family";
export type TransactionSource = "gmail" | "mfme" | "photo";
export type TransactionStatus =
  | "pending"
  | "classified"
  | "approved"
  | "submitted"
  | "attached"
  | "rejected";
export type RuleType = "fixed" | "learned" | "conditional";

export interface OcrResult {
  vendor: string;
  amount: number;
  date: string;
  description: string;
  invoiceNumber: string | null;
  currency: string;
  raw: Record<string, unknown>;
}

export interface Classification {
  bucket: Bucket;
  confidence: number;
  reason: string;
  details?: string;
}

export interface TransactionRecord {
  id: string;
  source: TransactionSource;
  sourceId: string | null;
  vendor: string;
  amount: number;
  date: string;
  description: string;
  invoiceNumber: string | null;
  receiptImageUrl: string | null;
  ocrRaw: Record<string, unknown> | null;
  bucket: Bucket | null;
  confidence: number | null;
  classificationReason: string | null;
  status: TransactionStatus;
  mfTransactionId: string | null;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
