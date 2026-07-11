"use client";

import { useCallback, useEffect, useState } from "react";
import { Nav } from "@/components/nav";

interface Client {
  id: string;
  name: string;
  mfPartnerId: string | null;
  mfDepartmentId: string | null;
}

interface Schedule {
  id: string;
  clientId: string;
  clientName: string | null;
  title: string;
  amount: number;
  issueDayOfMonth: number;
  active: boolean;
  lastGeneratedMonth: string | null;
}

interface Invoice {
  id: string;
  kind: "invoice" | "quote";
  status: "draft" | "created_in_mf" | "sent" | "paid" | "void";
  clientName: string | null;
  title: string;
  amount: number;
  issueDate: string | null;
  dueDate: string | null;
  mfInvoiceId: string | null;
  mfPdfUrl: string | null;
}

interface BillingAlert {
  level: "error" | "warn";
  message: string;
}

interface MfPartner {
  id: string;
  name: string;
  departments?: { id: string; name?: string }[];
}

const yen = (n: number) => `¥${n.toLocaleString()}`;

const STATUS_LABELS: Record<Invoice["status"], string> = {
  draft: "未発行",
  created_in_mf: "MF作成済",
  sent: "送付済",
  paid: "入金済",
  void: "取消",
};

const STATUS_COLORS: Record<Invoice["status"], string> = {
  draft: "bg-red-100 text-red-700",
  created_in_mf: "bg-yellow-100 text-yellow-800",
  sent: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  void: "bg-gray-100 text-gray-500",
};

export default function BillingPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [alerts, setAlerts] = useState<BillingAlert[]>([]);
  const [partners, setPartners] = useState<MfPartner[] | null>(null);
  const [busy, setBusy] = useState(false);

  // 新規フォーム state
  const [newClientName, setNewClientName] = useState("");
  const [inv, setInv] = useState({
    kind: "invoice" as "invoice" | "quote",
    clientId: "",
    title: "",
    amount: "",
  });
  const [sched, setSched] = useState({
    clientId: "",
    title: "",
    amount: "",
    issueDayOfMonth: "25",
  });

  const fetchAll = useCallback(async () => {
    try {
      const [c, s, i, a] = await Promise.all([
        fetch("/api/billing/clients").then((x) => x.json()).catch(() => ({})),
        fetch("/api/billing/schedules").then((x) => x.json()).catch(() => ({})),
        fetch("/api/billing/invoices").then((x) => x.json()).catch(() => ({})),
        fetch("/api/alerts").then((x) => x.json()).catch(() => ({})),
      ]);
      setClients(c.clients ?? []);
      setSchedules(s.schedules ?? []);
      setInvoices(i.invoices ?? []);
      setAlerts(a.billing ?? []);
    } catch {
      // ネットワーク断: 既存表示を維持
    }
  }, []);

  useEffect(() => {
     
    fetchAll();
  }, [fetchAll]);

  async function post(url: string, body: unknown, method = "POST") {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      await fetchAll();
      if (!res.ok) {
        alert(`失敗しました: ${data.error ?? res.status}`);
        return null;
      }
      return data;
    } catch (e) {
      alert(`通信エラー: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadPartners() {
    const res = await fetch("/api/billing/mf-partners");
    const data = await res.json();
    if (res.ok) setPartners(data.partners);
    else alert(`MF取引先の取得に失敗: ${data.error}`);
  }

  async function linkPartner(client: Client, partner: MfPartner) {
    const depts = partner.departments ?? [];
    const dept = depts[0];
    // 複数部署がある取引先は先頭を黙って選ばない（誤請求先防止）
    if (depts.length > 1) {
      const ok = confirm(
        `「${partner.name}」には部署が${depts.length}件あります。\n` +
          `先頭の「${dept?.name ?? dept?.id}」を請求先にしますか？\n` +
          `（別の部署にする場合はキャンセルし、MF側で確認してください）`
      );
      if (!ok) return;
    }
    await post(
      "/api/billing/clients",
      {
        id: client.id,
        mfPartnerId: partner.id,
        mfDepartmentId: dept?.id ?? "",
      },
      "PATCH"
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">請求管理 — 見積書・請求書</h1>
        <Nav />
      </div>

      {/* ===== アラート ===== */}
      {alerts.length > 0 && (
        <div className="mb-6 space-y-2">
          {alerts.map((a, i) => (
            <div
              key={i}
              className={`px-4 py-2 rounded-lg border text-sm ${
                a.level === "error"
                  ? "bg-red-50 border-red-200 text-red-800"
                  : "bg-yellow-50 border-yellow-200 text-yellow-800"
              }`}
            >
              {a.level === "error" ? "🔴" : "⚠️"} {a.message}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* ===== 取引先 ===== */}
        <div className="bg-card rounded-lg p-4 border border-border">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">取引先</h2>
            <button
              onClick={loadPartners}
              className="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200"
            >
              MF取引先を読込
            </button>
          </div>
          <div className="space-y-2">
            {clients.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between text-sm border-b border-border pb-2"
              >
                <div>
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-2 text-xs text-muted">
                    {c.mfDepartmentId
                      ? "✓ MF連携済"
                      : "MF未連携（自動起票にはMF取引先の紐付けが必要）"}
                  </span>
                </div>
                {partners && !c.mfDepartmentId && (
                  <select
                    disabled={busy}
                    defaultValue=""
                    onChange={(e) => {
                      const p = partners.find((x) => x.id === e.target.value);
                      if (p) linkPartner(c, p);
                    }}
                    className="text-xs px-2 py-1 border border-border rounded"
                  >
                    <option value="">MF取引先を選択…</option>
                    {partners.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
            <div className="flex gap-2 pt-1">
              <input
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
                placeholder="新しい取引先名"
                className="flex-1 px-2 py-1.5 border border-border rounded text-sm"
              />
              <button
                disabled={busy || !newClientName.trim()}
                onClick={async () => {
                  await post("/api/billing/clients", { name: newClientName.trim() });
                  setNewClientName("");
                }}
                className="text-xs px-3 py-1.5 bg-primary text-white rounded hover:bg-primary-hover disabled:opacity-50"
              >
                追加
              </button>
            </div>
          </div>
        </div>

        {/* ===== 単発発行 ===== */}
        <div className="bg-card rounded-lg p-4 border border-border">
          <h2 className="font-semibold mb-3">見積書・請求書を発行</h2>
          <div className="space-y-2 text-sm">
            <div className="flex gap-2">
              <select
                value={inv.kind}
                onChange={(e) =>
                  setInv({ ...inv, kind: e.target.value as "invoice" | "quote" })
                }
                className="px-2 py-1.5 border border-border rounded"
              >
                <option value="invoice">請求書</option>
                <option value="quote">見積書</option>
              </select>
              <select
                value={inv.clientId}
                onChange={(e) => setInv({ ...inv, clientId: e.target.value })}
                className="flex-1 px-2 py-1.5 border border-border rounded"
              >
                <option value="">取引先を選択…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <input
              value={inv.title}
              onChange={(e) => setInv({ ...inv, title: e.target.value })}
              placeholder="件名（例: Webサイト制作費）"
              className="w-full px-2 py-1.5 border border-border rounded"
            />
            <div className="flex gap-2 items-center">
              <input
                type="number"
                value={inv.amount}
                onChange={(e) => setInv({ ...inv, amount: e.target.value })}
                placeholder="金額（税抜）"
                className="flex-1 px-2 py-1.5 border border-border rounded text-right"
              />
              <button
                disabled={busy || !inv.clientId || !inv.title || !inv.amount}
                onClick={async () => {
                  const data = await post("/api/billing/invoices", {
                    ...inv,
                    amount: Number(inv.amount),
                  });
                  if (data) {
                    if (data.mfError)
                      alert(
                        `ローカルに起票しました。MF作成は失敗:\n${data.mfError}`
                      );
                    setInv({ kind: "invoice", clientId: "", title: "", amount: "" });
                  }
                }}
                className="px-4 py-1.5 bg-primary text-white rounded hover:bg-primary-hover disabled:opacity-50"
              >
                発行
              </button>
            </div>
            <p className="text-[11px] text-muted">
              MF請求書接続済み+取引先MF連携済みならMFにドラフト作成まで自動。送付はMF UIから。
            </p>
          </div>

          <h2 className="font-semibold mb-2 mt-5">定期請求（毎月自動起票）</h2>
          <div className="space-y-2 text-sm">
            {schedules.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between text-xs border-b border-border pb-1"
              >
                <span>
                  {s.clientName} / {s.title} — {yen(s.amount)}・毎月
                  {s.issueDayOfMonth}日
                  {!s.active && "（無効）"}
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    post(
                      "/api/billing/schedules",
                      { id: s.id, active: !s.active },
                      "PATCH"
                    )
                  }
                  className="px-2 py-0.5 bg-gray-100 rounded hover:bg-gray-200"
                >
                  {s.active ? "無効化" : "有効化"}
                </button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <select
                value={sched.clientId}
                onChange={(e) => setSched({ ...sched, clientId: e.target.value })}
                className="px-2 py-1.5 border border-border rounded text-xs"
              >
                <option value="">取引先…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <input
                value={sched.title}
                onChange={(e) => setSched({ ...sched, title: e.target.value })}
                placeholder="件名（例: 顧問料）"
                className="px-2 py-1.5 border border-border rounded text-xs w-32"
              />
              <input
                type="number"
                value={sched.amount}
                onChange={(e) => setSched({ ...sched, amount: e.target.value })}
                placeholder="金額"
                className="px-2 py-1.5 border border-border rounded text-xs w-24 text-right"
              />
              <input
                type="number"
                value={sched.issueDayOfMonth}
                onChange={(e) =>
                  setSched({ ...sched, issueDayOfMonth: e.target.value })
                }
                placeholder="発行日"
                className="px-2 py-1.5 border border-border rounded text-xs w-16 text-right"
              />
              <button
                disabled={busy || !sched.clientId || !sched.title || !sched.amount}
                onClick={async () => {
                  await post("/api/billing/schedules", {
                    ...sched,
                    amount: Number(sched.amount),
                    issueDayOfMonth: Number(sched.issueDayOfMonth),
                  });
                  setSched({ clientId: "", title: "", amount: "", issueDayOfMonth: "25" });
                }}
                className="text-xs px-3 py-1.5 bg-primary text-white rounded hover:bg-primary-hover disabled:opacity-50"
              >
                追加
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ===== 請求書一覧 ===== */}
      <h2 className="text-lg font-semibold mb-3">発行履歴</h2>
      <div className="bg-card rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-gray-50 text-left">
              <th className="p-2">種別</th>
              <th className="p-2">発行日</th>
              <th className="p-2">取引先 / 件名</th>
              <th className="p-2 text-right">金額(税抜)</th>
              <th className="p-2">期日</th>
              <th className="p-2">状態</th>
              <th className="p-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {invoices.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted">
                  まだ発行履歴がありません
                </td>
              </tr>
            )}
            {invoices.map((v) => (
              <tr key={v.id} className="border-b border-border hover:bg-gray-50">
                <td className="p-2 text-xs">
                  {v.kind === "quote" ? "見積" : "請求"}
                </td>
                <td className="p-2 whitespace-nowrap text-xs">{v.issueDate}</td>
                <td className="p-2">
                  <span className="text-xs text-muted">{v.clientName}</span>{" "}
                  <span className="font-medium">{v.title}</span>
                </td>
                <td className="p-2 text-right font-mono">{yen(v.amount)}</td>
                <td className="p-2 text-xs whitespace-nowrap">{v.dueDate}</td>
                <td className="p-2">
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[v.status]}`}
                  >
                    {STATUS_LABELS[v.status]}
                  </span>
                </td>
                <td className="p-2">
                  <div className="flex gap-1">
                    {v.mfPdfUrl && (
                      <a
                        href={`/api/billing/invoices/${v.id}/pdf`}
                        target="_blank"
                        className="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200"
                      >
                        PDF
                      </a>
                    )}
                    {v.status === "created_in_mf" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          post(
                            "/api/billing/invoices",
                            { id: v.id, status: "sent" },
                            "PATCH"
                          )
                        }
                        className="text-xs px-2 py-1 bg-blue-100 text-blue-800 rounded hover:bg-blue-200"
                      >
                        送付済に
                      </button>
                    )}
                    {v.status === "sent" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          post(
                            "/api/billing/invoices",
                            { id: v.id, status: "paid" },
                            "PATCH"
                          )
                        }
                        className="text-xs px-2 py-1 bg-green-100 text-green-800 rounded hover:bg-green-200"
                      >
                        入金済に
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
