import {
  getValidAccessToken,
  getStoredToken,
  saveToken,
  type TokenProvider,
} from "@/lib/integrations/token-store";

/**
 * MoneyForward クラウド経費 外部API v1 クライアント。
 *
 * - OpenAPI spec: https://expense.moneyforward.com/api/index.json
 *   （docs: https://github.com/moneyforward/expense-api-doc）
 * - トークンはDB保存（oauth_tokens）。リフレッシュトークンは使い捨てローテーション。
 * - 経費「申請」(ex_report) の作成APIは存在しない — 明細(ex_transaction)登録＋
 *   領収書画像添付までが自動化範囲。申請への取りまとめはMF Web UIで行う。
 */

const MF_API_BASE = "https://expense.moneyforward.com/api/external/v1";
const MF_OAUTH_BASE = "https://expense.moneyforward.com/oauth";

export type MfCompany = "nagi" | "stadiums";

/**
 * バケツ → MFクラウド経費の会社マッピング。
 * family は「MF MEで妻に共有」運用のため経費APIの対象外（null）。
 */
export function mfCompanyForBucket(bucket: string | null): MfCompany | null {
  if (bucket === "nagi") return "nagi";
  if (bucket === "stadiums") return "stadiums";
  return null;
}

function providerFor(company: MfCompany): TokenProvider {
  return company === "nagi" ? "mf_expense:nagi" : "mf_expense:stadiums";
}

function clientCreds(company: MfCompany): {
  clientId: string;
  clientSecret: string;
} | null {
  const prefix = company === "nagi" ? "MF_NAGI" : "MF_STADIUMS";
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// ---- OAuth ----

export const MF_EXPENSE_SCOPES =
  "office_setting:write user_setting:write transaction:write report:write public_resource:read";

export function buildAuthorizeUrl(
  company: MfCompany,
  redirectUri: string,
  state: string
): string {
  const creds = clientCreds(company);
  if (!creds) {
    throw new Error(
      `MF_${company === "nagi" ? "NAGI" : "STADIUMS"}_CLIENT_ID/SECRET が未設定です`
    );
  }
  const p = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: MF_EXPENSE_SCOPES,
    state,
  });
  return `${MF_OAUTH_BASE}/authorize?${p}`;
}

interface MfTokenResponse {
  access_token: string;
  token_type: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  created_at?: number;
}

async function tokenRequest(
  company: MfCompany,
  params: Record<string, string>
): Promise<MfTokenResponse> {
  const creds = clientCreds(company);
  if (!creds) throw new Error(`MF ${company} のclient credentialsが未設定です`);
  const res = await fetch(`${MF_OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      ...params,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MF token request failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as MfTokenResponse;
}

/** 認可コード交換＋事業者(office)発見＋DB保存。OAuth callbackから呼ぶ。 */
export async function exchangeCodeAndConnect(
  company: MfCompany,
  code: string,
  redirectUri: string
): Promise<{ offices: { id: string; name: string }[] }> {
  const token = await tokenRequest(company, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  // 事業者一覧を取得（このトークンでアクセスできるoffice）。
  // 失敗を握り潰すと設定UIで事業者が選べず復旧不能になるため明示エラーにする
  const officesRes = await fetch(`${MF_API_BASE}/offices`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!officesRes.ok) {
    const body = await officesRes.text();
    throw new Error(
      `事業者一覧の取得に失敗しました (${officesRes.status}): ${body.slice(0, 200)}`
    );
  }
  let offices: { id: string; name: string }[] = [];
  {
    const data = (await officesRes.json()) as {
      offices?: { id: string | number; name?: string }[];
    };
    const list = Array.isArray(data) ? data : (data.offices ?? []);
    offices = (list as { id: string | number; name?: string }[]).map((o) => ({
      id: String(o.id),
      name: o.name ?? String(o.id),
    }));
  }

  // office自動選択: envで明示 > 1件のみなら自動 > 未選択（設定UIで選ぶ）
  const envOfficeId =
    process.env[`MF_${company === "nagi" ? "NAGI" : "STADIUMS"}_OFFICE_ID`];
  const officeId =
    envOfficeId && offices.some((o) => o.id === envOfficeId)
      ? envOfficeId
      : offices.length === 1
        ? offices[0].id
        : (envOfficeId ?? null);

  // 再接続時に設定済みの選択（office/経費科目）を引き継ぐ（毎回リセットさせない）
  const prev = await getStoredToken(providerFor(company));
  const prevOfficeId = prev?.meta?.officeId as string | null | undefined;
  const prevExItemId = prev?.meta?.defaultExItemId as string | null | undefined;

  await saveToken(
    providerFor(company),
    {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      scope: token.scope ?? null,
      expiresInSec: token.expires_in,
    },
    {
      offices,
      officeId:
        officeId ??
        (prevOfficeId && offices.some((o) => o.id === prevOfficeId)
          ? prevOfficeId
          : null),
      defaultExItemId: prevExItemId ?? null,
    }
  );

  return { offices };
}

async function refreshExpenseToken(company: MfCompany, refreshToken: string) {
  const t = await tokenRequest(company, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    scope: t.scope ?? null,
    expiresInSec: t.expires_in,
  };
}

async function getAccessContext(company: MfCompany): Promise<{
  accessToken: string;
  officeId: string;
  defaultExItemId: string | null;
}> {
  const { accessToken, meta } = await getValidAccessToken(
    providerFor(company),
    (rt) => refreshExpenseToken(company, rt)
  );
  const officeId = (meta?.officeId as string | null) ?? null;
  if (!officeId) {
    throw new Error(
      `MF ${company} の事業者(office)が未選択です。設定画面で選択してください`
    );
  }
  return {
    accessToken,
    officeId,
    defaultExItemId: (meta?.defaultExItemId as string | null) ?? null,
  };
}

// ---- 設定状態 ----

export interface MfConfigStatus {
  configured: boolean;
  reason?: string;
  needsOfficeSelection?: boolean;
  needsExItemSelection?: boolean;
}

/** MF連携の利用可否チェック。UIとsubmitルートの503判定に使う。 */
export async function getMfConfigStatus(
  company: MfCompany
): Promise<MfConfigStatus> {
  if (!clientCreds(company)) {
    const prefix = company === "nagi" ? "MF_NAGI" : "MF_STADIUMS";
    return {
      configured: false,
      reason: `MFクラウド経費の認証情報が未設定です（env: ${prefix}_CLIENT_ID / ${prefix}_CLIENT_SECRET）`,
    };
  }
  const stored = await getStoredToken(providerFor(company));
  if (!stored) {
    return {
      configured: false,
      reason: `MF ${company} は未接続です。設定画面からOAuth接続してください`,
    };
  }
  if (!stored.refreshToken) {
    const expired =
      stored.expiresAt !== null && Date.now() > stored.expiresAt.getTime();
    if (expired) {
      return {
        configured: false,
        reason: `MF ${company} のトークンが失効しています（要再接続）`,
      };
    }
  }
  const officeId = (stored.meta?.officeId as string | null) ?? null;
  if (!officeId) {
    return {
      configured: false,
      reason: `MF ${company} の事業者(office)が未選択です`,
      needsOfficeSelection: true,
    };
  }
  const exItemId = (stored.meta?.defaultExItemId as string | null) ?? null;
  if (!exItemId) {
    return {
      configured: false,
      reason: `MF ${company} の経費科目が未選択です（設定画面で選択）`,
      needsExItemSelection: true,
    };
  }
  return { configured: true };
}

// ---- API操作 ----

/** 経費科目一覧（設定UIのデフォルト科目選択用） */
export async function listExItems(
  company: MfCompany
): Promise<{ id: string; name: string }[]> {
  const { accessToken, meta } = await getValidAccessToken(
    providerFor(company),
    (rt) => refreshExpenseToken(company, rt)
  );
  const officeId = (meta?.officeId as string | null) ?? null;
  if (!officeId) throw new Error(`MF ${company} の事業者が未選択です`);

  const res = await fetch(
    `${MF_API_BASE}/offices/${officeId}/ex_items?page=1&per=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`ex_items取得失敗: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    ex_items?: { id: string | number; name?: string }[];
  };
  const list = Array.isArray(data) ? data : (data.ex_items ?? []);
  return (list as { id: string | number; name?: string }[]).map((i) => ({
    id: String(i.id),
    name: i.name ?? String(i.id),
  }));
}

export interface MfTransactionInput {
  date: string;
  amount: number;
  vendor: string;
  description: string;
  invoiceNumber?: string | null;
  /** 領収書画像（電子帳簿保存法対応の証憑添付）。Base64・4MB目安まで */
  receiptImage?: {
    base64: string;
    contentType: string;
    filename: string;
  } | null;
}

/**
 * 経費明細(ex_transaction)を作成する。
 * 必須: value / recognized_at / remark(支払先,max100字) / ex_item_id
 * 任意: memo / invoice_registration_number + invoice_kind / receipt_input(証憑)
 */
export async function createMfTransaction(
  company: MfCompany,
  input: MfTransactionInput
) {
  const { accessToken, officeId, defaultExItemId } =
    await getAccessContext(company);
  if (!defaultExItemId) {
    throw new Error(
      `MF ${company} の経費科目(ex_item)が未選択です。設定画面で選択してください`
    );
  }

  const exTransaction: Record<string, unknown> = {
    value: input.amount,
    recognized_at: input.date,
    remark: input.vendor.slice(0, 100),
    ex_item_id: defaultExItemId,
    memo: input.description.slice(0, 500),
  };
  if (input.invoiceNumber) {
    exTransaction.invoice_registration_number = input.invoiceNumber;
    exTransaction.invoice_kind = 2; // 適格請求書
  }
  if (input.receiptImage) {
    exTransaction.receipt_input = {
      content: input.receiptImage.base64,
      content_type: input.receiptImage.contentType,
      filename: input.receiptImage.filename,
    };
  }

  const res = await fetch(
    `${MF_API_BASE}/offices/${officeId}/me/ex_transactions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ex_transaction: exTransaction }),
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `MF transaction creation failed: ${res.status} ${errorText.slice(0, 500)}`
    );
  }

  return await res.json();
}
