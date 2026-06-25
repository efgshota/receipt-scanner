const MF_API_BASE = "https://expense.moneyforward.com/api/external/v1";

interface MfTokens {
  access_token: string;
  token_type: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
}

interface MfTransactionInput {
  date: string;
  amount: number;
  vendor: string;
  description: string;
  invoiceNumber?: string | null;
}

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

// In-memory token cache (will be replaced with DB storage in Phase 2)
const tokenCache: Record<string, MfTokens> = {};

/**
 * MF連携が利用可能かを事前チェック（UIに「未設定/再認証が必要」を明示するため）。
 * 認証情報や有効なトークンが無い場合に submit ルートが 503 を返せるようにする。
 */
export function getMfConfigStatus(
  company: MfCompany
): { configured: boolean; reason?: string } {
  const prefix = company === "nagi" ? "MF_NAGI" : "MF_STADIUMS";
  const missing = [
    `${prefix}_CLIENT_ID`,
    `${prefix}_CLIENT_SECRET`,
    `${prefix}_OFFICE_ID`,
  ].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return {
      configured: false,
      reason: `MFクラウド経費の認証情報が未設定です（.env: ${missing.join(", ")}）`,
    };
  }

  // OAuthトークン（tokens.json）の有無と有効期限を確認
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");
    const tokensPath = path.join(process.cwd(), "tokens.json");
    if (!fs.existsSync(tokensPath)) {
      return { configured: false, reason: "tokens.json が無く OAuth 未認証です" };
    }
    const parsed = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as Record<
      string,
      MfTokens | undefined
    >;
    const t = parsed[company];
    if (!t) {
      return {
        configured: false,
        reason: `tokens.json に ${company} のトークンがありません（要OAuth認証）`,
      };
    }
    // refresh_token があれば access_token が失効していても更新可能
    if (!t.refresh_token) {
      const expiresAt = (t.created_at + t.expires_in) * 1000;
      if (Date.now() > expiresAt) {
        return {
          configured: false,
          reason: `${company} のトークンが失効しており refresh_token もありません（要再OAuth認証）`,
        };
      }
    }
  } catch (e) {
    return {
      configured: false,
      reason: `トークン確認に失敗: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { configured: true };
}

async function refreshToken(
  company: MfCompany,
  tokens: MfTokens
): Promise<MfTokens> {
  const clientId =
    company === "nagi"
      ? process.env.MF_NAGI_CLIENT_ID!
      : process.env.MF_STADIUMS_CLIENT_ID!;
  const clientSecret =
    company === "nagi"
      ? process.env.MF_NAGI_CLIENT_SECRET!
      : process.env.MF_STADIUMS_CLIENT_SECRET!;

  const res = await fetch("https://expense.moneyforward.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`MF token refresh failed: ${res.status}`);
  }

  const newTokens = (await res.json()) as MfTokens;
  tokenCache[company] = newTokens;
  persistTokens(company, newTokens);
  return newTokens;
}

/** リフレッシュ後の新トークンを tokens.json に書き戻す（再起動後も有効に保つ） */
function persistTokens(company: MfCompany, tokens: MfTokens): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");
    const tokensPath = path.join(process.cwd(), "tokens.json");
    const parsed = fs.existsSync(tokensPath)
      ? (JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as Record<string, unknown>)
      : {};
    parsed[company] = tokens;
    fs.writeFileSync(tokensPath, JSON.stringify(parsed, null, 2));
  } catch {
    // 書き戻し失敗は致命的でない（メモリキャッシュで当面動作する）
  }
}

async function getAccessToken(company: MfCompany): Promise<string> {
  let tokens = tokenCache[company];

  if (!tokens) {
    // Load from tokens.json at runtime (file is gitignored, may be absent)
    const fs = await import("fs");
    const path = await import("path");
    const tokensPath = path.join(process.cwd(), "tokens.json");
    if (!fs.existsSync(tokensPath)) {
      throw new Error("tokens.json not found — MF OAuth tokens not configured");
    }
    const parsed = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as Record<
      string,
      MfTokens | undefined
    >;
    const loaded = parsed[company];
    if (!loaded) {
      throw new Error(
        `tokens.json に ${company} のトークンがありません（要OAuth認証）`
      );
    }
    tokens = loaded;
    tokenCache[company] = tokens;
  }

  // Check if token is expired (with 5 min buffer)
  const expiresAt = (tokens.created_at + tokens.expires_in) * 1000;
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    tokens = await refreshToken(company, tokens);
  }

  return tokens.access_token;
}

export async function createMfTransaction(
  company: MfCompany,
  input: MfTransactionInput
) {
  const accessToken = await getAccessToken(company);

  const officeId =
    company === "nagi"
      ? process.env.MF_NAGI_OFFICE_ID!
      : process.env.MF_STADIUMS_OFFICE_ID!;

  const body = {
    office_member_id: officeId,
    ex_transaction: {
      value: input.amount,
      recognized_at: input.date,
      jpyrate: 1,
      dept_id: null,
      project_code_id: null,
      ex_item_id: null,
      dr_excise_id: null,
      cr_item_id: null,
      cr_sub_item_id: null,
      memo: `${input.vendor} - ${input.description}`,
    },
  };

  const res = await fetch(
    `${MF_API_BASE}/offices/${officeId}/me/ex_transactions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`MF transaction creation failed: ${res.status} ${errorText}`);
  }

  return await res.json();
}
