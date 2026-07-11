"use client";

import { useCallback, useEffect, useState } from "react";
import { Nav } from "@/components/nav";
import type { Bucket } from "@/lib/types";

interface MfExpenseState {
  configured: boolean;
  reason?: string;
  needsOfficeSelection?: boolean;
  needsExItemSelection?: boolean;
  offices: { id: string; name: string }[];
  officeId: string | null;
  defaultExItemId: string | null;
}

interface StatusResponse {
  mfExpense: { nagi: MfExpenseState; stadiums: MfExpenseState };
  mfInvoice: { configured: boolean; reason?: string; officeName?: string };
  gmail: { accounts: { name: string; email: string }[]; configured: boolean };
  cronConfigured: boolean;
}

interface Rule {
  id: string;
  name: string;
  vendorPattern: string;
  bucket: Bucket;
  expectedAmount: number;
  amountTolerance: number;
  dayOfMonth: number;
  active: boolean;
  autoSubmit: boolean;
  lastGeneratedMonth: string | null;
}

interface Suggestion {
  name: string;
  vendorPattern: string;
  expectedAmount: number;
  bucket: Bucket;
  dayOfMonth: number;
  occurrences: number;
  monthsSeen: number;
}

interface IngestLogRow {
  id: string;
  account: string;
  subject: string | null;
  outcome: string;
  detail: string | null;
  createdAt: string;
}

const yen = (n: number) => `¥${n.toLocaleString()}`;

const BUCKET_LABELS: Record<Bucket, string> = {
  nagi: "NAGI",
  stadiums: "stadiums",
  family: "家族",
};

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
        ok ? "bg-green-100 text-green-800" : "bg-red-100 text-red-700"
      }`}
    >
      {label}
    </span>
  );
}

export default function SettingsPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [logs, setLogs] = useState<IngestLogRow[]>([]);
  const [exItems, setExItems] = useState<
    Record<string, { id: string; name: string }[]>
  >({});
  const [busy, setBusy] = useState(false);
  const [cronResult, setCronResult] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [s, r, g, l] = await Promise.all([
        fetch("/api/mf/status").then((x) => x.json()).catch(() => null),
        fetch("/api/recurring").then((x) => x.json()).catch(() => ({})),
        fetch("/api/recurring/suggestions").then((x) => x.json()).catch(() => ({})),
        fetch("/api/ingest/log").then((x) => x.json()).catch(() => ({})),
      ]);
      if (s) setStatus(s);
      setRules(r.rules ?? []);
      setSuggestions(g.suggestions ?? []);
      setLogs(l.logs ?? []);
    } catch {
      setNotice("データ取得に失敗しました。再読み込みしてください");
    }
  }, []);

  useEffect(() => {
     
    fetchAll();
    // OAuthコールバックからの戻りを通知
    const p = new URLSearchParams(window.location.search);
    const err = p.get("mf_error") ?? p.get("mfi_error");
    const ok = p.get("mf_connected") ?? (p.get("mfi_connected") ? "請求書" : null);
    if (err) setNotice(`接続エラー: ${err}`);
    else if (ok) setNotice(`接続に成功しました（${ok}）`);
  }, [fetchAll]);

  async function loadExItems(company: "nagi" | "stadiums") {
    const res = await fetch(`/api/mf/config?company=${company}`);
    const data = await res.json();
    if (res.ok) setExItems((m) => ({ ...m, [company]: data.exItems }));
    else alert(`経費科目の取得に失敗: ${data.error}`);
  }

  async function saveConfig(
    company: "nagi" | "stadiums",
    patch: { officeId?: string; defaultExItemId?: string }
  ) {
    setBusy(true);
    try {
      const res = await fetch("/api/mf/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, ...patch }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(`保存に失敗: ${e.error}`);
      }
      await fetchAll();
    } finally {
      setBusy(false);
    }
  }

  async function addRule(r: Partial<Rule>) {
    setBusy(true);
    try {
      const res = await fetch("/api/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(`追加に失敗: ${e.error}`);
      }
      await fetchAll();
    } finally {
      setBusy(false);
    }
  }

  async function patchRule(id: string, patch: Partial<Rule>) {
    setBusy(true);
    try {
      await fetch(`/api/recurring/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      await fetchAll();
    } finally {
      setBusy(false);
    }
  }

  async function runCronNow() {
    if (!confirm("日次バッチ（サブスク生成→請求起票→MF提出→メール取込）を今すぐ実行しますか？"))
      return;
    setBusy(true);
    try {
      setCronResult("実行中…（数十秒〜数分かかることがあります）");
      const res = await fetch("/api/cron/daily?days=7");
      const data = await res.json();
      setCronResult(JSON.stringify(data, null, 2));
      await fetchAll();
    } catch (e) {
      setCronResult(`実行エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const mfCard = (company: "nagi" | "stadiums", st: MfExpenseState) => (
    <div className="bg-card rounded-lg p-4 border border-border">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">
          MFクラウド経費 — {company === "nagi" ? "NAGI" : "stadiums"}
        </h3>
        <Badge ok={st.configured} label={st.configured ? "接続済み" : "未設定"} />
      </div>
      {!st.configured && (
        <p className="mt-2 text-xs text-muted">{st.reason}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a
          href={`/api/mf/oauth/start?company=${company}`}
          className="text-xs px-3 py-1.5 bg-primary text-white rounded hover:bg-primary-hover"
        >
          {st.offices.length > 0 ? "再接続" : "OAuth接続"}
        </a>
        {st.offices.length > 0 && (
          <select
            disabled={busy}
            value={st.officeId ?? ""}
            onChange={(e) => {
              if (!e.target.value) return; // プレースホルダ選択は無視
              saveConfig(company, { officeId: e.target.value });
            }}
            className="text-xs px-2 py-1.5 border border-border rounded"
          >
            <option value="">事業者を選択…</option>
            {st.offices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        )}
        {st.officeId && (
          <>
            {exItems[company] ? (
              <select
                disabled={busy}
                value={st.defaultExItemId ?? ""}
                onChange={(e) => {
                  if (!e.target.value) return; // プレースホルダ選択は無視
                  saveConfig(company, { defaultExItemId: e.target.value });
                }}
                className="text-xs px-2 py-1.5 border border-border rounded"
              >
                <option value="">経費科目を選択…</option>
                {exItems[company].map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            ) : (
              <button
                onClick={() => loadExItems(company)}
                className="text-xs px-2 py-1.5 bg-gray-100 rounded hover:bg-gray-200"
              >
                経費科目を読込
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">設定</h1>
        <Nav />
      </div>

      {notice && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800">
          {notice}
        </div>
      )}

      {/* ===== 連携 ===== */}
      <h2 className="text-lg font-semibold mb-3">外部連携</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {status && mfCard("nagi", status.mfExpense.nagi)}
        {status && mfCard("stadiums", status.mfExpense.stadiums)}

        <div className="bg-card rounded-lg p-4 border border-border">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">MFクラウド請求書</h3>
            <Badge
              ok={Boolean(status?.mfInvoice.configured)}
              label={status?.mfInvoice.configured ? "接続済み" : "未設定"}
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            {status?.mfInvoice.configured
              ? `事業者: ${status.mfInvoice.officeName ?? "-"}`
              : status?.mfInvoice.reason}
          </p>
          <a
            href="/api/mf-invoice/oauth/start"
            className="mt-3 inline-block text-xs px-3 py-1.5 bg-primary text-white rounded hover:bg-primary-hover"
          >
            OAuth接続
          </a>
        </div>

        <div className="bg-card rounded-lg p-4 border border-border">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Gmail 領収書取込</h3>
            <Badge
              ok={Boolean(status?.gmail.configured)}
              label={
                status?.gmail.configured
                  ? `${status.gmail.accounts.length}アカウント`
                  : "未設定"
              }
            />
          </div>
          <div className="mt-2 text-xs text-muted space-y-0.5">
            {status?.gmail.accounts.map((a) => (
              <div key={a.name}>
                {a.name} — {a.email}
              </div>
            ))}
            {!status?.gmail.configured && (
              <div>env GMAIL_ACCOUNTS / GMAIL_CREDENTIALS_* が未設定です</div>
            )}
          </div>
        </div>
      </div>

      {/* ===== 手動実行 ===== */}
      <div className="bg-card rounded-lg p-4 border border-border mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">日次バッチ</h3>
            <p className="text-xs text-muted mt-1">
              毎朝5時台に自動実行（メール取込 → サブスク生成 → MF提出 → 請求起票）。
              {status?.cronConfigured ? "" : " ⚠ CRON_SECRET未設定のため自動実行は無効です。"}
            </p>
          </div>
          <button
            disabled={busy}
            onClick={runCronNow}
            className="text-sm px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
          >
            今すぐ実行
          </button>
        </div>
        {cronResult && (
          <pre className="mt-3 p-3 bg-gray-50 rounded text-[11px] overflow-x-auto max-h-64">
            {cronResult}
          </pre>
        )}
      </div>

      {/* ===== サブスクルール ===== */}
      <h2 className="text-lg font-semibold mb-3">サブスク（定期支出）ルール</h2>
      <div className="bg-card rounded-lg border border-border overflow-x-auto mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-gray-50 text-left">
              <th className="p-2">名前</th>
              <th className="p-2">マッチパターン</th>
              <th className="p-2">バケツ</th>
              <th className="p-2 text-right">金額</th>
              <th className="p-2">生成日</th>
              <th className="p-2">自動提出</th>
              <th className="p-2">状態</th>
              <th className="p-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 && (
              <tr>
                <td colSpan={8} className="p-4 text-center text-muted">
                  ルールがありません。下の候補から追加するか手動で作成してください。
                </td>
              </tr>
            )}
            {rules.map((r) => (
              <tr key={r.id} className="border-b border-border">
                <td className="p-2 font-medium">{r.name}</td>
                <td className="p-2 text-xs text-muted">{r.vendorPattern}</td>
                <td className="p-2 text-xs">{BUCKET_LABELS[r.bucket]}</td>
                <td className="p-2 text-right font-mono">
                  {yen(r.expectedAmount)}
                  <span className="text-[10px] text-muted">
                    ±{Math.round(r.amountTolerance * 100)}%
                  </span>
                </td>
                <td className="p-2 text-xs">毎月{r.dayOfMonth}日</td>
                <td className="p-2 text-xs">{r.autoSubmit ? "MFまで" : "承認まで"}</td>
                <td className="p-2">
                  <Badge ok={r.active} label={r.active ? "有効" : "無効"} />
                </td>
                <td className="p-2">
                  <button
                    disabled={busy}
                    onClick={() => patchRule(r.id, { active: !r.active })}
                    className="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50"
                  >
                    {r.active ? "無効化" : "有効化"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {suggestions.length > 0 && (
        <>
          <h3 className="text-sm font-semibold mb-2 text-muted">
            履歴からの候補（2ヶ月以上出現・金額安定）
          </h3>
          <div className="flex flex-wrap gap-2 mb-8">
            {suggestions.map((s) => (
              <button
                key={s.vendorPattern}
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      `サブスクルールを追加: ${s.name}\n${yen(s.expectedAmount)}/月・${BUCKET_LABELS[s.bucket]}・毎月${s.dayOfMonth}日生成・MF自動提出\nよろしいですか？`
                    )
                  )
                    addRule(s);
                }}
                className="text-xs px-3 py-1.5 bg-blue-50 border border-blue-200 text-blue-800 rounded-lg hover:bg-blue-100 disabled:opacity-50"
              >
                + {s.name} {yen(s.expectedAmount)}（{s.monthsSeen}ヶ月/{s.occurrences}回）
              </button>
            ))}
          </div>
        </>
      )}

      {/* ===== 取込ログ ===== */}
      <h2 className="text-lg font-semibold mb-3">メール取込ログ（直近50件）</h2>
      <div className="bg-card rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-gray-50 text-left">
              <th className="p-2">日時</th>
              <th className="p-2">アカウント</th>
              <th className="p-2">件名</th>
              <th className="p-2">結果</th>
              <th className="p-2">詳細</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted">
                  まだ取込履歴がありません
                </td>
              </tr>
            )}
            {logs.map((l) => (
              <tr key={l.id} className="border-b border-border">
                <td className="p-2 whitespace-nowrap text-muted">
                  {new Date(l.createdAt).toLocaleString("ja-JP")}
                </td>
                <td className="p-2">{l.account}</td>
                <td className="p-2 max-w-xs truncate">{l.subject}</td>
                <td className="p-2 whitespace-nowrap">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      l.outcome === "imported"
                        ? "bg-green-100 text-green-800"
                        : l.outcome === "matched_recurring"
                          ? "bg-blue-100 text-blue-800"
                          : l.outcome === "error"
                            ? "bg-red-100 text-red-700"
                            : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {l.outcome}
                  </span>
                </td>
                <td className="p-2 max-w-sm truncate text-muted">{l.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
