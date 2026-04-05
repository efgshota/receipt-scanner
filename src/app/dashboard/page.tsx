"use client";

import { useState, useEffect, useCallback } from "react";
import type { Bucket, TransactionStatus } from "@/lib/types";

interface Transaction {
  id: string;
  source: string;
  vendor: string;
  amount: number;
  date: string;
  description: string;
  invoiceNumber: string | null;
  receiptImageUrl: string | null;
  bucket: Bucket | null;
  confidence: number | null;
  classificationReason: string | null;
  status: TransactionStatus;
  createdAt: string;
}

const BUCKET_LABELS: Record<Bucket, string> = {
  nagi: "NAGI",
  stadiums: "stadiums",
  family: "家族",
};

const BUCKET_COLORS: Record<Bucket, string> = {
  nagi: "bg-blue-100 text-blue-800",
  stadiums: "bg-purple-100 text-purple-800",
  family: "bg-green-100 text-green-800",
};

const STATUS_LABELS: Record<TransactionStatus, string> = {
  pending: "要確認",
  classified: "分類済",
  approved: "承認済",
  submitted: "提出済",
  attached: "添付済",
  rejected: "却下",
};

function confidenceBar(confidence: number | null) {
  if (confidence === null) return null;
  const pct = Math.round(confidence * 100);
  const color =
    pct >= 85 ? "bg-green-500" : pct >= 50 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-2 bg-gray-200 rounded-full">
        <div
          className={`h-2 rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted">{pct}%</span>
    </div>
  );
}

export default function DashboardPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterBucket, setFilterBucket] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filterStatus !== "all") params.set("status", filterStatus);
    if (filterBucket !== "all") params.set("bucket", filterBucket);

    const res = await fetch(`/api/transactions?${params}`);
    const data = await res.json();
    setTransactions(data.transactions || []);
    setLoading(false);
  }, [filterStatus, filterBucket]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  async function updateTransaction(
    id: string,
    updates: { bucket?: Bucket; status?: TransactionStatus }
  ) {
    await fetch(`/api/transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    fetchTransactions();
  }

  const totals = transactions.reduce(
    (acc, tx) => {
      if (tx.bucket) {
        acc[tx.bucket] = (acc[tx.bucket] || 0) + tx.amount;
      }
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">Receipt Scanner</h1>
        <a
          href="/upload"
          className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
        >
          レシート撮影
        </a>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {(["nagi", "stadiums", "family"] as Bucket[]).map((b) => (
          <div key={b} className="bg-card rounded-lg p-4 border border-border">
            <div className="text-sm text-muted">{BUCKET_LABELS[b]}</div>
            <div className="text-2xl font-bold mt-1">
              ¥{(totals[b] || 0).toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 border border-border rounded-lg bg-card"
        >
          <option value="all">全ステータス</option>
          <option value="pending">要確認</option>
          <option value="classified">分類済</option>
          <option value="approved">承認済</option>
          <option value="submitted">提出済</option>
        </select>
        <select
          value={filterBucket}
          onChange={(e) => setFilterBucket(e.target.value)}
          className="px-3 py-2 border border-border rounded-lg bg-card"
        >
          <option value="all">全バケツ</option>
          <option value="nagi">NAGI</option>
          <option value="stadiums">stadiums</option>
          <option value="family">家族</option>
        </select>
      </div>

      {/* Transaction table */}
      {loading ? (
        <div className="text-center py-12 text-muted">読み込み中...</div>
      ) : transactions.length === 0 ? (
        <div className="text-center py-12 text-muted">
          トランザクションがありません
        </div>
      ) : (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-gray-50">
                <th className="text-left p-3">日付</th>
                <th className="text-left p-3">店舗</th>
                <th className="text-right p-3">金額</th>
                <th className="text-left p-3">バケツ</th>
                <th className="text-left p-3">確信度</th>
                <th className="text-left p-3">ステータス</th>
                <th className="text-left p-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr
                  key={tx.id}
                  className="border-b border-border hover:bg-gray-50"
                >
                  <td className="p-3 whitespace-nowrap">{tx.date}</td>
                  <td className="p-3">
                    <div className="font-medium">{tx.vendor}</div>
                    {tx.description && (
                      <div className="text-xs text-muted">{tx.description}</div>
                    )}
                  </td>
                  <td className="p-3 text-right font-mono">
                    ¥{tx.amount.toLocaleString()}
                  </td>
                  <td className="p-3">
                    {tx.bucket && (
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-medium ${BUCKET_COLORS[tx.bucket]}`}
                      >
                        {BUCKET_LABELS[tx.bucket]}
                      </span>
                    )}
                  </td>
                  <td className="p-3">{confidenceBar(tx.confidence)}</td>
                  <td className="p-3">
                    <span className="text-xs">{STATUS_LABELS[tx.status]}</span>
                  </td>
                  <td className="p-3">
                    <div className="flex gap-1">
                      {/* Bucket reassignment */}
                      {tx.status !== "submitted" && (
                        <select
                          value={tx.bucket || ""}
                          onChange={(e) =>
                            updateTransaction(tx.id, {
                              bucket: e.target.value as Bucket,
                              status: "classified",
                            })
                          }
                          className="text-xs px-1 py-1 border border-border rounded"
                        >
                          <option value="nagi">NAGI</option>
                          <option value="stadiums">stadiums</option>
                          <option value="family">家族</option>
                        </select>
                      )}
                      {/* Approve button */}
                      {(tx.status === "pending" ||
                        tx.status === "classified") && (
                        <button
                          onClick={() =>
                            updateTransaction(tx.id, { status: "approved" })
                          }
                          className="text-xs px-2 py-1 bg-green-100 text-green-800 rounded hover:bg-green-200"
                        >
                          承認
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
