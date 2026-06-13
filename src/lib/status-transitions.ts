import type { TransactionStatus } from "@/lib/types";

export const ALL_STATUSES: TransactionStatus[] = [
  "pending",
  "classified",
  "approved",
  "submitted",
  "attached",
  "rejected",
];

// 各ステータスに遷移できる「正当な前ステータス」
// （お金の状態を守るため、未承認のまま提出済になることを防ぐ）
export const ALLOWED_FROM: Record<TransactionStatus, TransactionStatus[]> = {
  pending: ["pending", "classified", "approved"], // 差戻し含む
  classified: ["pending", "classified", "approved"],
  approved: ["pending", "classified", "approved"], // 承認は要確認/分類済から
  submitted: ["approved", "submitted"], // 提出は承認済からのみ
  attached: ["submitted", "attached"],
  rejected: ["pending", "classified", "approved", "submitted", "attached", "rejected"],
};

export function isValidStatus(s: unknown): s is TransactionStatus {
  return typeof s === "string" && (ALL_STATUSES as string[]).includes(s);
}

// from -> to が正当か
export function isLegalTransition(
  from: TransactionStatus,
  to: TransactionStatus
): boolean {
  if (from === to) return true;
  return ALLOWED_FROM[to]?.includes(from) ?? false;
}

// 編集（バケツ/金額/日付/店舗）をロックすべきステータス
export function isLocked(status: TransactionStatus): boolean {
  return status === "submitted" || status === "attached";
}
