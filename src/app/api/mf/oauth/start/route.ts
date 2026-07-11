import { NextResponse } from "next/server";
import crypto from "crypto";
import {
  buildAuthorizeUrl,
  type MfCompany,
} from "@/lib/integrations/mf-expense-api";

/**
 * MFクラウド経費 OAuth開始。GET /api/mf/oauth/start?company=nagi|stadiums
 * CSRF対策: ランダムstateをhttpOnly cookieに保存し、callbackで照合する。
 * 注意: MF経費のredirect_uriはhttpsのみ許可（ローカル開発では本番URL経由で接続する）。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const company = url.searchParams.get("company");
  if (company !== "nagi" && company !== "stadiums") {
    return NextResponse.json(
      { error: "company は nagi | stadiums を指定してください" },
      { status: 400 }
    );
  }

  const redirectUri = `${url.origin}/api/mf/oauth/callback`;
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = `${nonce}.${company}`;

  let authorizeUrl: string;
  try {
    authorizeUrl = buildAuthorizeUrl(company as MfCompany, redirectUri, state);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 }
    );
  }

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set("mf_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600, // 認可コードは10分で失効するためstateも同寿命
    path: "/api/mf/oauth",
  });
  return res;
}
