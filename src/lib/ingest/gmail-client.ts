/**
 * Gmail REST クライアント（today101/mcp/gmail-multi の方式を移植・拡張）。
 *
 * - 認証情報は env の JSON: GMAIL_ACCOUNTS="personal,ttne,stadiums,zapass"
 *   GMAIL_CREDENTIALS_<NAME>='{"client_id":"..","client_secret":"..","refresh_token":".."}'
 * - Googleのrefresh_tokenはローテーションしない（MFと違い固定）ため、
 *   実行毎に access_token を取得すればよくDB保存は不要。
 * - googleapis パッケージは使わずRESTを直接叩く（サーバレスのcold start軽量化）。
 */

const ACCOUNT_EMAILS: Record<string, string> = {
  personal: "efgshota@gmail.com",
  ttne: "s.fujii@ttne.jp",
  stadiums: "s.fujii@stadiums.co.jp",
  zapass: "zapass",
};

export interface GmailAccount {
  name: string;
  email: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function listGmailAccounts(): GmailAccount[] {
  const names = (process.env.GMAIL_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const accounts: GmailAccount[] = [];
  for (const name of names) {
    const raw = process.env[`GMAIL_CREDENTIALS_${name.toUpperCase()}`];
    if (!raw) continue;
    try {
      const c = JSON.parse(raw) as {
        client_id: string;
        client_secret: string;
        refresh_token: string;
      };
      if (!c.client_id || !c.client_secret || !c.refresh_token) continue;
      accounts.push({
        name,
        email: ACCOUNT_EMAILS[name.toLowerCase()] ?? name,
        clientId: c.client_id,
        clientSecret: c.client_secret,
        refreshToken: c.refresh_token,
      });
    } catch {
      // 壊れたJSONはスキップ（設定画面のstatusで気づける）
    }
  }
  return accounts;
}

export async function getGmailAccessToken(a: GmailAccount): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: a.clientId,
      client_secret: a.clientSecret,
      refresh_token: a.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Gmail token refresh failed (${a.name}): ${res.status} ${body.slice(0, 200)}`
    );
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmailApi<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail API ${path.split("?")[0]} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function searchMessageIds(
  accessToken: string,
  query: string,
  max: number
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < max) {
    const p = new URLSearchParams({
      q: query,
      maxResults: String(Math.min(50, max - ids.length)),
    });
    if (pageToken) p.set("pageToken", pageToken);
    const data = await gmailApi<{
      messages?: { id: string }[];
      nextPageToken?: string;
    }>(accessToken, `/messages?${p}`);
    for (const m of data.messages ?? []) ids.push(m.id);
    if (!data.nextPageToken || (data.messages ?? []).length === 0) break;
    pageToken = data.nextPageToken;
  }
  return ids;
}

// ---- メッセージ解析 ----

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export interface ParsedMessage {
  messageId: string;
  subject: string;
  from: string;
  dateHeader: string;
  internalDate: Date;
  bodyText: string;
  attachments: {
    filename: string;
    mimeType: string;
    attachmentId: string;
    size: number;
  }[];
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf-8"
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBodyText(payload: GmailPart | undefined): string {
  if (!payload) return "";
  if (payload.body?.data) {
    const text = decodeB64Url(payload.body.data);
    return payload.mimeType === "text/html" ? stripHtml(text) : text;
  }
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return decodeB64Url(plain.body.data);
    const html = payload.parts.find((p) => p.mimeType === "text/html");
    if (html?.body?.data) return stripHtml(decodeB64Url(html.body.data));
    for (const part of payload.parts) {
      const nested = extractBodyText(part);
      if (nested) return nested;
    }
  }
  return "";
}

function collectAttachments(
  payload: GmailPart | undefined,
  out: ParsedMessage["attachments"]
): void {
  if (!payload) return;
  if (payload.body?.attachmentId && payload.filename) {
    out.push({
      filename: payload.filename,
      mimeType: payload.mimeType ?? "application/octet-stream",
      attachmentId: payload.body.attachmentId,
      size: payload.body.size ?? 0,
    });
  }
  for (const p of payload.parts ?? []) collectAttachments(p, out);
}

export async function getMessage(
  accessToken: string,
  messageId: string
): Promise<ParsedMessage> {
  const msg = await gmailApi<{
    id: string;
    internalDate?: string;
    payload?: GmailPart & {
      headers?: { name?: string; value?: string }[];
    };
  }>(accessToken, `/messages/${messageId}?format=full`);

  const headers = msg.payload?.headers ?? [];
  const h = (name: string) =>
    headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

  const attachments: ParsedMessage["attachments"] = [];
  collectAttachments(msg.payload, attachments);

  return {
    messageId: msg.id,
    subject: h("Subject"),
    from: h("From"),
    dateHeader: h("Date"),
    internalDate: msg.internalDate
      ? new Date(Number(msg.internalDate))
      : new Date(0),
    bodyText: extractBodyText(msg.payload).slice(0, 20000),
    attachments,
  };
}

/** 添付データ取得（base64url → base64） */
export async function getAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string
): Promise<Buffer> {
  const data = await gmailApi<{ data?: string }>(
    accessToken,
    `/messages/${messageId}/attachments/${attachmentId}`
  );
  if (!data.data) throw new Error("attachment data missing");
  return Buffer.from(data.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
