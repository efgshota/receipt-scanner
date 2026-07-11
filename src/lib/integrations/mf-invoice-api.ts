import {
  getValidAccessToken,
  getStoredToken,
  saveToken,
} from "@/lib/integrations/token-store";

/**
 * MoneyForward クラウド請求書 API v3 クライアント。
 *
 * - リファレンス: https://invoice.moneyforward.com/docs/api/v3/index.html
 * - OAuthは経費と別系統: authorize/token とも https://api.biz.moneyforward.com
 *   （アプリ登録は https://app-portal.moneyforward.com/apps/ 、CLIENT_SECRET_BASIC）
 * - アクセストークン1時間 / リフレッシュ540日・使い捨てローテーション
 * - 請求書作成は POST /invoice_template_billings のみ
 *   （旧 POST /billings は2025-03-25廃止。必須は department_id / billing_date / sales_date）
 * - 書き込み系は3リクエスト/秒制限 → 直列+スリープで呼ぶこと
 * - メール送付APIは存在しない（ドラフト作成まで。送付はMF UI）
 */

const INVOICE_API_BASE = "https://invoice.moneyforward.com/api/v3";
const BIZ_OAUTH_BASE = "https://api.biz.moneyforward.com";

const PROVIDER = "mf_invoice:nagi" as const;
export const MF_INVOICE_SCOPE = "mfc/invoice/data.write";

function clientCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.MF_INVOICE_CLIENT_ID;
  const clientSecret = process.env.MF_INVOICE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// ---- OAuth ----

export function buildInvoiceAuthorizeUrl(
  redirectUri: string,
  state: string
): string {
  const creds = clientCreds();
  if (!creds) {
    throw new Error("MF_INVOICE_CLIENT_ID / MF_INVOICE_CLIENT_SECRET が未設定です");
  }
  const p = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    scope: MF_INVOICE_SCOPE,
    state,
  });
  return `${BIZ_OAUTH_BASE}/authorize?${p}`;
}

interface BizTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

/** トークンエンドポイント（クライアント認証 = CLIENT_SECRET_BASIC） */
async function bizTokenRequest(
  params: Record<string, string>
): Promise<BizTokenResponse> {
  const creds = clientCreds();
  if (!creds) throw new Error("MF請求書のclient credentialsが未設定です");
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString(
    "base64"
  );
  const res = await fetch(`${BIZ_OAUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `MF invoice token request failed: ${res.status} ${body.slice(0, 300)}`
    );
  }
  return (await res.json()) as BizTokenResponse;
}

export async function exchangeInvoiceCode(
  code: string,
  redirectUri: string
): Promise<void> {
  const t = await bizTokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  // 事業者情報を取得してmetaに保存（接続確認を兼ねる）
  let office: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${INVOICE_API_BASE}/office`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    if (res.ok) office = (await res.json()) as Record<string, unknown>;
  } catch {
    // office取得失敗は致命的でない
  }
  await saveToken(
    PROVIDER,
    {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      scope: t.scope ?? MF_INVOICE_SCOPE,
      expiresInSec: t.expires_in,
    },
    { office }
  );
}

async function getAccessToken(): Promise<string> {
  const { accessToken } = await getValidAccessToken(PROVIDER, async (rt) => {
    const t = await bizTokenRequest({
      grant_type: "refresh_token",
      refresh_token: rt,
    });
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      scope: t.scope ?? null,
      expiresInSec: t.expires_in,
    };
  });
  return accessToken;
}

export interface MfInvoiceStatus {
  configured: boolean;
  reason?: string;
  officeName?: string;
}

export async function getMfInvoiceStatus(): Promise<MfInvoiceStatus> {
  if (!clientCreds()) {
    return {
      configured: false,
      reason:
        "MF請求書の認証情報が未設定です（env: MF_INVOICE_CLIENT_ID / MF_INVOICE_CLIENT_SECRET）",
    };
  }
  const stored = await getStoredToken(PROVIDER);
  if (!stored) {
    return {
      configured: false,
      reason: "MF請求書は未接続です。設定画面からOAuth接続してください",
    };
  }
  const office = stored.meta?.office as Record<string, unknown> | undefined;
  return {
    configured: true,
    officeName: (office?.name as string) ?? undefined,
  };
}

// ---- APIヘルパー ----

// 書き込み系 3req/s 制限対応の直列スリープ
const WRITE_INTERVAL_MS = 400;
let lastWriteAt = 0;
async function writeThrottle() {
  const wait = lastWriteAt + WRITE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastWriteAt = Date.now();
}

async function api<T>(
  path: string,
  init?: RequestInit & { isWrite?: boolean }
): Promise<T> {
  if (init?.isWrite) await writeThrottle();
  const token = await getAccessToken();
  const doFetch = () =>
    fetch(`${INVOICE_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  let res = await doFetch();
  // 3req/s制限の429はRetry-Afterを尊重して1回だけ再試行
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "1");
    await new Promise((r) =>
      setTimeout(r, Math.min(10, Math.max(1, retryAfter)) * 1000)
    );
    res = await doFetch();
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `MF invoice API ${path} failed: ${res.status} ${body.slice(0, 500)}`
    );
  }
  return (await res.json()) as T;
}

/** レスポンスからid/pdf_urlを取り出す（ネスト形にもヘッジ）。id欠落は即エラー */
function extractBillingResult(raw: Record<string, unknown>): MfBillingResult {
  const nested = (raw.billing ?? raw.quote ?? raw.data) as
    | Record<string, unknown>
    | undefined;
  const id = raw.id ?? nested?.id;
  if (id == null || String(id) === "") {
    throw new Error(
      `MF請求書レスポンスにidがありません: ${JSON.stringify(raw).slice(0, 300)}`
    );
  }
  return {
    id: String(id),
    pdfUrl: ((raw.pdf_url ?? nested?.pdf_url) as string) ?? null,
    raw,
  };
}

export interface MfPartner {
  id: string;
  name: string;
  departments?: { id: string; name?: string }[];
}

export async function listPartners(): Promise<MfPartner[]> {
  const data = await api<{ data?: unknown[] } | unknown[]>(
    "/partners?page=1&per_page=100"
  );
  const list = Array.isArray(data)
    ? data
    : ((data as { data?: unknown[] }).data ?? []);
  return (list as Record<string, unknown>[]).map((p) => ({
    id: String(p.id),
    name: (p.name as string) ?? String(p.id),
    departments: ((p.departments as Record<string, unknown>[]) ?? []).map(
      (d) => ({ id: String(d.id), name: (d.name as string) ?? undefined })
    ),
  }));
}

export interface InvoiceItemInput {
  name: string;
  price: number; // 税抜単価
  quantity: number;
  // 消費税区分: ten_percent | eight_percent_as_reduced_tax_rate | non_taxable 等
  excise?: string;
}

export interface CreateBillingInput {
  departmentId: string; // 帳票作成に使うのは partner_id ではなく department_id
  title: string;
  billingDate: string; // YYYY-MM-DD
  salesDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD — 取引先に支払期日設定が無い場合は省略でエラーになるため必須で送る
  items: InvoiceItemInput[];
  memo?: string;
}

export interface MfBillingResult {
  id: string;
  pdfUrl: string | null;
  raw: unknown;
}

/** 請求書ドラフト作成（POST /invoice_template_billings） */
export async function createBilling(
  input: CreateBillingInput
): Promise<MfBillingResult> {
  const body = {
    department_id: input.departmentId,
    title: input.title,
    billing_date: input.billingDate,
    sales_date: input.salesDate,
    due_date: input.dueDate,
    memo: input.memo ?? "",
    items: input.items.map((it) => ({
      name: it.name,
      price: it.price,
      quantity: it.quantity,
      excise: it.excise ?? "ten_percent",
    })),
  };
  const raw = await api<Record<string, unknown>>("/invoice_template_billings", {
    method: "POST",
    body: JSON.stringify(body),
    isWrite: true,
  });
  return extractBillingResult(raw);
}

export interface CreateQuoteInput {
  departmentId: string;
  title: string;
  quoteDate: string; // YYYY-MM-DD
  expiredDate: string; // YYYY-MM-DD
  items: InvoiceItemInput[];
  memo?: string;
}

/** 見積書作成（POST /quotes） */
export async function createQuote(
  input: CreateQuoteInput
): Promise<MfBillingResult> {
  const body = {
    department_id: input.departmentId,
    title: input.title,
    quote_date: input.quoteDate,
    expired_date: input.expiredDate,
    memo: input.memo ?? "",
    items: input.items.map((it) => ({
      name: it.name,
      price: it.price,
      quantity: it.quantity,
      excise: it.excise ?? "ten_percent",
    })),
  };
  const raw = await api<Record<string, unknown>>("/quotes", {
    method: "POST",
    body: JSON.stringify(body),
    isWrite: true,
  });
  return extractBillingResult(raw);
}

/** 見積書 → 請求書へ変換（受注時） */
export async function convertQuoteToBilling(
  quoteId: string
): Promise<MfBillingResult> {
  const raw = await api<Record<string, unknown>>(
    `/quotes/${quoteId}/convert_to_billing`,
    { method: "POST", isWrite: true }
  );
  return extractBillingResult(raw);
}

/**
 * PDF取得。pdf_url はBearer必須（ブラウザ直リンク不可）のためサーバ側で取得し
 * Blob保存 or プロキシ配信に使う。
 */
export async function fetchPdf(pdfUrl: string): Promise<Buffer> {
  const token = await getAccessToken();
  const res = await fetch(pdfUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`MF invoice PDF fetch failed: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
