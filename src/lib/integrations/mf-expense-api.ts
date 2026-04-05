const MF_API_BASE = "https://expense.moneyforward.com/api/external/v1";

interface MfTokens {
  access_token: string;
  token_type: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
}

interface MfTransactionInput {
  officeId: string;
  date: string;
  amount: number;
  vendor: string;
  description: string;
  invoiceNumber?: string | null;
}

// In-memory token cache (will be replaced with DB storage in Phase 2)
const tokenCache: Record<string, MfTokens> = {};

async function refreshToken(
  company: "nagi" | "stadiums",
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
  return newTokens;
}

async function getAccessToken(company: "nagi" | "stadiums"): Promise<string> {
  let tokens = tokenCache[company];

  if (!tokens) {
    // Load from env or initial setup
    // For now, we only support NAGI with existing tokens
    if (company === "nagi") {
      const tokensJson = await import("../../../tokens.json");
      tokens = tokensJson.nagi as MfTokens;
      tokenCache[company] = tokens;
    } else {
      throw new Error("stadiums MF tokens not configured");
    }
  }

  // Check if token is expired (with 5 min buffer)
  const expiresAt = (tokens.created_at + tokens.expires_in) * 1000;
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    tokens = await refreshToken(company, tokens);
  }

  return tokens.access_token;
}

export async function createMfTransaction(
  company: "nagi" | "stadiums",
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
