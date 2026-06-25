"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { Bucket, TransactionStatus } from "@/lib/types";

interface Transaction {
  id: string;
  source: string;
  vendor: string;
  amount: number;
  date: string | null;
  description: string;
  invoiceNumber: string | null;
  receiptImageUrl: string | null;
  bucket: Bucket | null;
  confidence: number | null;
  classificationReason: string | null;
  status: TransactionStatus;
  mfTransactionId: string | null;
  submittedAt: string | null;
  createdAt: string;
}

// バケツ→MFクラウド経費の対象会社（family は MF ME 共有運用＝API対象外）
const MF_BUCKETS: Bucket[] = ["nagi", "stadiums"];
const isMfBucket = (b: Bucket | null): boolean =>
  b !== null && MF_BUCKETS.includes(b);

interface StatusCell {
  count: number;
  amount: number;
}
interface BucketStat {
  bucket: Bucket;
  total: { count: number; amount: number };
  byStatus: Record<TransactionStatus, StatusCell>;
  submittedRate: number;
  remaining: { count: number; amount: number };
}
interface Stats {
  buckets: BucketStat[];
  unbucketed: { count: number; amount: number };
  grand: { count: number; amount: number };
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

// 進捗バー用の色（左から右へ精算が進む）
const STATUS_BAR_COLORS: Record<TransactionStatus, string> = {
  pending: "bg-red-400",
  classified: "bg-yellow-400",
  approved: "bg-blue-400",
  submitted: "bg-green-500",
  attached: "bg-green-600",
  rejected: "bg-gray-300",
};

const yen = (n: number) => `¥${n.toLocaleString()}`;

// ---- 異常検知 ----
interface Anomaly {
  label: string;
  cls: string;
}
function detectAnomalies(tx: Transaction): Anomaly[] {
  const a: Anomaly[] = [];
  if (!tx.date) a.push({ label: "日付なし", cls: "bg-red-100 text-red-700" });
  else if (Number(tx.date.slice(0, 4)) < 2025)
    a.push({ label: "日付要確認", cls: "bg-red-100 text-red-700" });
  if (tx.amount <= 0) a.push({ label: "¥0要確認", cls: "bg-red-100 text-red-700" });
  if (tx.amount >= 100000) a.push({ label: "高額", cls: "bg-orange-100 text-orange-700" });
  if (tx.classificationReason?.includes("⚠"))
    a.push({ label: "要確認", cls: "bg-orange-100 text-orange-700" });
  if (!tx.receiptImageUrl)
    a.push({ label: "レシートなし", cls: "bg-gray-100 text-gray-600" });
  return a;
}

// 一括承認で除外すべき「目視必須」の異常（レシートなしは情報バッジなので除外しない）
function needsManualReview(tx: Transaction): boolean {
  if (!tx.date) return true;
  if (Number(tx.date.slice(0, 4)) < 2025) return true;
  if (tx.amount <= 0) return true;
  if (tx.amount >= 100000) return true;
  if (tx.classificationReason?.includes("⚠")) return true;
  return false;
}

// レビュー優先度: 異常あり > 確信度低い順
function reviewPriority(tx: Transaction): number {
  const anomalyScore = detectAnomalies(tx).length * 1000;
  const confScore = 1 - (tx.confidence ?? 0); // 低確信ほど大
  return anomalyScore + confScore;
}

// 金額の正規化（全角数字・カンマ・¥を許容）
function normalizeAmount(raw: string): number {
  const cleaned = raw
    .replace(/[０-９]/g, (d) => String("０１２３４５６７８９".indexOf(d)))
    .replace(/[,，\s¥￥]/g, "");
  return Number(cleaned);
}

function confidenceBar(confidence: number | null) {
  if (confidence === null) return <span className="text-xs text-muted">—</span>;
  const pct = Math.round(confidence * 100);
  const color =
    pct >= 85 ? "bg-green-500" : pct >= 50 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="w-12 h-2 bg-gray-200 rounded-full">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted">{pct}%</span>
    </div>
  );
}

export default function DashboardPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brokenImg, setBrokenImg] = useState<Set<string>>(new Set());

  // フィルタ / ソート
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterBucket, setFilterBucket] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("review");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [hideSubmitted, setHideSubmitted] = useState(false);

  // インライン編集
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ date: string; vendor: string; amount: string }>({
    date: "",
    vendor: "",
    amount: "",
  });

  const fetchAll = useCallback(async () => {
    const [txRes, statsRes] = await Promise.all([
      fetch("/api/transactions"),
      fetch("/api/transactions/stats"),
    ]);
    const txData = await txRes.json();
    const statsData = await statsRes.json();
    setTransactions(txData.transactions || []);
    setStats(statsData);
    setLoading(false);
  }, []);

  useEffect(() => {
    // マウント時の初回データ取得（setStateはawait後＝非同期で実行される）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll();
  }, [fetchAll]);

  async function patchTx(
    id: string,
    updates: Partial<{
      bucket: Bucket;
      status: TransactionStatus;
      date: string | null;
      vendor: string;
      amount: number;
    }>
  ) {
    if (busy) return;
    setBusy(true);
    const res = await fetch(`/api/transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert(`更新できませんでした: ${e.error ?? res.status}`);
    }
    await fetchAll();
    setBusy(false);
  }

  async function bulk(
    bucket: Bucket,
    fromStatus: TransactionStatus[],
    toStatus: TransactionStatus,
    confirmMsg: string
  ) {
    if (busy) return;
    // 対象行をクライアント側で抽出
    const candidates = transactions.filter(
      (t) => t.bucket === bucket && fromStatus.includes(t.status)
    );
    // 一括承認は「目視必須」の異常値を除外（未確認のまま承認しない）
    const skip =
      toStatus === "approved" ? candidates.filter((t) => needsManualReview(t)) : [];
    const skipIds = new Set(skip.map((t) => t.id));
    const targets = candidates.filter((t) => !skipIds.has(t.id));

    if (targets.length === 0) {
      alert(
        skip.length > 0
          ? `対象 ${candidates.length}件は全て要確認のため除外しました。画面でレビューしてください。`
          : "対象の取引がありません"
      );
      return;
    }
    const skipNote =
      skip.length > 0
        ? `\n（${skip.length}件は要確認のため除外。個別に確認してください）`
        : "";
    if (
      !confirm(
        `${BUCKET_LABELS[bucket]}: ${targets.length}件を${confirmMsg}${skipNote}\nよろしいですか？`
      )
    )
      return;

    setBusy(true);
    const res = await fetch("/api/transactions/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket,
        fromStatus,
        toStatus,
        ids: targets.map((t) => t.id),
      }),
    });
    const data = await res.json().catch(() => ({}));
    await fetchAll();
    setBusy(false);
    if (!res.ok) alert(`処理できませんでした: ${data.error ?? res.status}`);
  }

  // 取引1件をMFクラウド経費へ直接提出
  async function submitToMf(id: string) {
    if (busy) return;
    if (!confirm("この取引をMFクラウド経費へ提出します。よろしいですか？")) return;
    setBusy(true);
    const res = await fetch(`/api/transactions/${id}/submit`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    await fetchAll();
    setBusy(false);
    if (!res.ok) alert(`MF提出に失敗しました: ${data.error ?? res.status}`);
  }

  // バケツ内の承認済をまとめてMFクラウド経費へ提出
  async function submitBucketToMf(bucket: Bucket) {
    if (busy) return;
    const targets = transactions.filter(
      (t) => t.bucket === bucket && t.status === "approved"
    );
    if (targets.length === 0) {
      alert("承認済の取引がありません（先に承認してください）");
      return;
    }
    if (
      !confirm(
        `${BUCKET_LABELS[bucket]}: 承認済 ${targets.length}件をMFクラウド経費へ提出します。\nよろしいですか？`
      )
    )
      return;
    setBusy(true);
    const res = await fetch("/api/transactions/submit-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: targets.map((t) => t.id) }),
    });
    const data = await res.json().catch(() => ({}));
    await fetchAll();
    setBusy(false);
    if (!res.ok) {
      alert(`MF一括提出に失敗しました: ${data.error ?? res.status}`);
      return;
    }
    if (data.aborted) {
      alert(`MF未設定のため中断しました: ${data.aborted}`);
    } else if (data.failedCount > 0) {
      alert(
        `提出 ${data.submitted}件 / 失敗 ${data.failedCount}件。\n失敗の先頭: ${data.failed?.[0]?.error ?? "-"}`
      );
    } else {
      alert(`${data.submitted}件をMFへ提出しました`);
    }
  }

  function startEdit(tx: Transaction) {
    setEditingId(tx.id);
    setDraft({
      date: tx.date ?? "",
      vendor: tx.vendor,
      amount: String(tx.amount),
    });
  }

  async function saveEdit(id: string) {
    const amount = normalizeAmount(draft.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      alert("金額を正の整数で入力してください");
      return;
    }
    if (!draft.vendor.trim()) {
      alert("店舗名を入力してください");
      return;
    }
    await patchTx(id, {
      date: draft.date || null,
      vendor: draft.vendor.trim(),
      amount,
    });
    setEditingId(null);
  }

  // ---- 表示用フィルタ/ソート ----
  const visible = useMemo(() => {
    let rows = [...transactions];
    if (filterBucket !== "all") rows = rows.filter((t) => t.bucket === filterBucket);
    if (filterStatus !== "all") rows = rows.filter((t) => t.status === filterStatus);
    if (hideSubmitted)
      rows = rows.filter((t) => t.status !== "submitted" && t.status !== "attached");
    if (reviewOnly)
      rows = rows.filter(
        (t) => detectAnomalies(t).length > 0 || (t.confidence ?? 0) < 0.85
      );

    rows.sort((a, b) => {
      if (sortBy === "review") return reviewPriority(b) - reviewPriority(a);
      if (sortBy === "amount") return b.amount - a.amount;
      if (sortBy === "date") return (b.date ?? "").localeCompare(a.date ?? "");
      if (sortBy === "confidence") return (a.confidence ?? 0) - (b.confidence ?? 0);
      return 0;
    });
    return rows;
  }, [transactions, filterBucket, filterStatus, hideSubmitted, reviewOnly, sortBy]);

  const exportUrl = (bucket: Bucket | "all") => {
    const p = new URLSearchParams();
    if (bucket !== "all") p.set("bucket", bucket);
    return `/api/transactions/export?${p}`;
  };
  const zipUrl = (bucket: Bucket | "all") => {
    const p = new URLSearchParams();
    if (bucket !== "all") p.set("bucket", bucket);
    return `/api/transactions/export/images?${p}`;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Receipt Scanner — 経費精算</h1>
        <a
          href="/upload"
          className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
        >
          レシート撮影
        </a>
      </div>

      {/* ===== 精算進捗パネル ===== */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {stats?.buckets.map((bs) => {
          const pct = Math.round(bs.submittedRate * 100);
          return (
            <div key={bs.bucket} className="bg-card rounded-lg p-4 border border-border">
              <div className="flex items-center justify-between">
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-medium ${BUCKET_COLORS[bs.bucket]}`}
                >
                  {BUCKET_LABELS[bs.bucket]}
                </span>
                <span className="text-xs text-muted">{bs.total.count}件</span>
              </div>
              <div className="text-2xl font-bold mt-2">{yen(bs.total.amount)}</div>

              {/* 進捗バー */}
              <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
                {(["pending", "classified", "approved", "submitted", "attached", "rejected"] as TransactionStatus[]).map(
                  (st) => {
                    const c = bs.byStatus[st].count;
                    if (!c) return null;
                    const w = (c / bs.total.count) * 100;
                    return (
                      <div
                        key={st}
                        className={STATUS_BAR_COLORS[st]}
                        style={{ width: `${w}%` }}
                        title={`${STATUS_LABELS[st]}: ${c}件`}
                      />
                    );
                  }
                )}
              </div>
              <div className="mt-1 flex items-center justify-between text-xs">
                <span className="text-muted">
                  提出済 {bs.byStatus.submitted.count + bs.byStatus.attached.count}/{bs.total.count}
                </span>
                <span className={pct === 100 ? "text-green-600 font-semibold" : "text-muted"}>
                  精算完了 {pct}%{pct === 100 ? " ✓" : ""}
                </span>
              </div>

              {/* ステータス内訳 */}
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-muted">
                {(["pending", "classified", "approved", "submitted", "attached", "rejected"] as TransactionStatus[]).map(
                  (st) =>
                    bs.byStatus[st].count > 0 ? (
                      <div key={st} className="flex justify-between">
                        <span>{STATUS_LABELS[st]}</span>
                        <span>
                          {bs.byStatus[st].count}件 / {yen(bs.byStatus[st].amount)}
                        </span>
                      </div>
                    ) : null
                )}
              </div>

              {/* バケツ別アクション */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                <button
                  disabled={busy}
                  onClick={() =>
                    bulk(bs.bucket, ["pending", "classified"], "approved", "まとめて承認します。")
                  }
                  className="text-xs px-2 py-1 bg-blue-100 text-blue-800 rounded hover:bg-blue-200 disabled:opacity-50"
                >
                  一括承認
                </button>
                {isMfBucket(bs.bucket) && (
                  <button
                    disabled={busy}
                    onClick={() => submitBucketToMf(bs.bucket)}
                    className="text-xs px-2 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                  >
                    MFへ一括提出
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    bulk(bs.bucket, ["approved"], "submitted", "「提出済」にします（精算実行後に押す）。")
                  }
                  className="text-xs px-2 py-1 bg-green-100 text-green-800 rounded hover:bg-green-200 disabled:opacity-50"
                  title="MF連携を使わず手動で提出済にする（CSV取込後など）"
                >
                  手動で提出済
                </button>
                <a
                  href={exportUrl(bs.bucket)}
                  className="text-xs px-2 py-1 bg-gray-100 text-gray-800 rounded hover:bg-gray-200"
                >
                  CSV
                </a>
                <a
                  href={zipUrl(bs.bucket)}
                  className="text-xs px-2 py-1 bg-gray-100 text-gray-800 rounded hover:bg-gray-200"
                >
                  画像ZIP
                </a>
              </div>
            </div>
          );
        })}
      </div>

      {/* 未分類（バケツなし）の警告 */}
      {stats && stats.unbucketed.count > 0 && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-orange-50 border border-orange-200 text-sm text-orange-800">
          ⚠ バケツ未設定の取引が {stats.unbucketed.count}件（{yen(stats.unbucketed.amount)}）あります。
          バケツを設定しないと精算対象から漏れます。
        </div>
      )}

      {/* ===== フィルタ / ソート ===== */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 border border-border rounded-lg bg-card text-sm"
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
          className="px-3 py-2 border border-border rounded-lg bg-card text-sm"
        >
          <option value="all">全バケツ</option>
          <option value="nagi">NAGI</option>
          <option value="stadiums">stadiums</option>
          <option value="family">家族</option>
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="px-3 py-2 border border-border rounded-lg bg-card text-sm"
        >
          <option value="review">要レビュー順</option>
          <option value="confidence">確信度 低い順</option>
          <option value="amount">金額 高い順</option>
          <option value="date">日付 新しい順</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={reviewOnly}
            onChange={(e) => setReviewOnly(e.target.checked)}
          />
          要レビューのみ（&lt;85% or 異常）
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={hideSubmitted}
            onChange={(e) => setHideSubmitted(e.target.checked)}
          />
          提出済を隠す
        </label>
        <span className="ml-auto text-sm text-muted">{visible.length}件表示</span>
      </div>

      {/* ===== テーブル ===== */}
      {loading ? (
        <div className="text-center py-12 text-muted">読み込み中...</div>
      ) : visible.length === 0 ? (
        <div className="text-center py-12 text-muted">該当する取引がありません</div>
      ) : (
        <div className="bg-card rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-gray-50">
                <th className="text-left p-2 w-14">画像</th>
                <th className="text-left p-2">日付</th>
                <th className="text-left p-2">店舗 / 内容</th>
                <th className="text-right p-2">金額</th>
                <th className="text-left p-2">バケツ</th>
                <th className="text-left p-2">確信度</th>
                <th className="text-left p-2">ステータス</th>
                <th className="text-left p-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((tx) => {
                const anomalies = detectAnomalies(tx);
                const editing = editingId === tx.id;
                const locked = tx.status === "submitted" || tx.status === "attached";
                return (
                  <tr key={tx.id} className="border-b border-border hover:bg-gray-50 align-top">
                    {/* 画像サムネ */}
                    <td className="p-2">
                      {tx.receiptImageUrl && !brokenImg.has(tx.id) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={tx.receiptImageUrl}
                          alt=""
                          onClick={() => setPreviewImage(tx.receiptImageUrl)}
                          onError={() =>
                            setBrokenImg((s) => {
                              const n = new Set(s);
                              n.add(tx.id);
                              return n;
                            })
                          }
                          className="w-10 h-10 object-cover rounded cursor-pointer border border-border hover:ring-2 hover:ring-primary"
                        />
                      ) : (
                        <div
                          className="w-10 h-10 rounded bg-gray-100 flex items-center justify-center text-[9px] text-muted"
                          title={tx.receiptImageUrl ? "画像読込失敗" : "レシートなし"}
                        >
                          {tx.receiptImageUrl ? "✕" : "なし"}
                        </div>
                      )}
                    </td>

                    {/* 日付 */}
                    <td className="p-2 whitespace-nowrap">
                      {editing ? (
                        <input
                          type="date"
                          value={draft.date}
                          onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                          className="border border-border rounded px-1 py-0.5 text-xs w-32"
                        />
                      ) : (
                        <span className={!tx.date ? "text-red-500" : ""}>
                          {tx.date ?? "日付なし"}
                        </span>
                      )}
                    </td>

                    {/* 店舗 / 内容 + 異常バッジ */}
                    <td className="p-2">
                      {editing ? (
                        <input
                          value={draft.vendor}
                          onChange={(e) => setDraft({ ...draft, vendor: e.target.value })}
                          className="border border-border rounded px-1 py-0.5 text-xs w-56"
                        />
                      ) : (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium">{tx.vendor}</span>
                          {anomalies.map((a) => (
                            <span
                              key={a.label}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${a.cls}`}
                            >
                              {a.label}
                            </span>
                          ))}
                        </div>
                      )}
                      {!editing && tx.description && (
                        <div className="text-xs text-muted">{tx.description}</div>
                      )}
                      {!editing && tx.classificationReason && (
                        <div className="text-[10px] text-muted/70">{tx.classificationReason}</div>
                      )}
                    </td>

                    {/* 金額 */}
                    <td className="p-2 text-right font-mono whitespace-nowrap">
                      {editing ? (
                        <input
                          type="number"
                          value={draft.amount}
                          onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                          className="border border-border rounded px-1 py-0.5 text-xs w-24 text-right"
                        />
                      ) : (
                        <span className={tx.amount <= 0 ? "text-red-500" : ""}>
                          {yen(tx.amount)}
                        </span>
                      )}
                    </td>

                    {/* バケツ */}
                    <td className="p-2">
                      {locked ? (
                        tx.bucket && (
                          <span
                            className={`px-2 py-1 rounded-full text-xs font-medium ${BUCKET_COLORS[tx.bucket]}`}
                          >
                            {BUCKET_LABELS[tx.bucket]}
                          </span>
                        )
                      ) : (
                        <select
                          disabled={busy}
                          value={tx.bucket || ""}
                          onChange={(e) => patchTx(tx.id, { bucket: e.target.value as Bucket })}
                          className="text-xs px-1 py-1 border border-border rounded disabled:opacity-50"
                        >
                          <option value="nagi">NAGI</option>
                          <option value="stadiums">stadiums</option>
                          <option value="family">家族</option>
                        </select>
                      )}
                    </td>

                    {/* 確信度 */}
                    <td className="p-2">{confidenceBar(tx.confidence)}</td>

                    {/* ステータス */}
                    <td className="p-2 whitespace-nowrap">
                      <span className="text-xs">{STATUS_LABELS[tx.status]}</span>
                      {tx.mfTransactionId && (
                        <div
                          className="text-[10px] text-emerald-700 font-medium"
                          title={`MF取引ID: ${tx.mfTransactionId}`}
                        >
                          ✓ MF連携済
                        </div>
                      )}
                      {tx.submittedAt && (
                        <div className="text-[10px] text-muted">
                          {new Date(tx.submittedAt).toLocaleDateString("ja-JP")}
                        </div>
                      )}
                    </td>

                    {/* 操作 */}
                    <td className="p-2">
                      <div className="flex flex-wrap gap-1">
                        {editing ? (
                          <>
                            <button
                              disabled={busy}
                              onClick={() => saveEdit(tx.id)}
                              className="text-xs px-2 py-1 bg-primary text-white rounded hover:bg-primary-hover disabled:opacity-50"
                            >
                              保存
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="text-xs px-2 py-1 bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            {!locked && (
                              <button
                                disabled={busy}
                                onClick={() => startEdit(tx)}
                                className="text-xs px-2 py-1 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-50"
                              >
                                編集
                              </button>
                            )}
                            {(tx.status === "pending" || tx.status === "classified") && (
                              <button
                                disabled={busy}
                                onClick={() => patchTx(tx.id, { status: "approved" })}
                                className="text-xs px-2 py-1 bg-blue-100 text-blue-800 rounded hover:bg-blue-200 disabled:opacity-50"
                              >
                                承認
                              </button>
                            )}
                            {tx.status === "approved" && isMfBucket(tx.bucket) && (
                              <button
                                disabled={busy}
                                onClick={() => submitToMf(tx.id)}
                                className="text-xs px-2 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                              >
                                MFへ提出
                              </button>
                            )}
                            {tx.status === "approved" && (
                              <button
                                disabled={busy}
                                onClick={() => patchTx(tx.id, { status: "submitted" })}
                                className="text-xs px-2 py-1 bg-green-100 text-green-800 rounded hover:bg-green-200 disabled:opacity-50"
                                title="MF連携を使わず手動で提出済にする"
                              >
                                提出済（手動）
                              </button>
                            )}
                            {locked && (
                              <button
                                disabled={busy}
                                onClick={() => patchTx(tx.id, { status: "approved" })}
                                className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 disabled:opacity-50"
                              >
                                差戻し
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 画像プレビュー */}
      {previewImage && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setPreviewImage(null)}
        >
          <div className="relative max-w-2xl max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setPreviewImage(null)}
              className="absolute -top-3 -right-3 w-8 h-8 bg-white rounded-full shadow flex items-center justify-center text-gray-600 hover:text-gray-900"
            >
              ✕
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewImage} alt="Receipt" className="max-h-[85vh] rounded-lg shadow-lg" />
          </div>
        </div>
      )}
    </div>
  );
}
