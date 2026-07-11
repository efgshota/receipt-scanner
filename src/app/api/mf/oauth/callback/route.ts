import { NextResponse } from "next/server";
import {
  exchangeCodeAndConnect,
  type MfCompany,
} from "@/lib/integrations/mf-expense-api";

/**
 * MFクラウド経費 OAuthコールバック。
 * state照合 → コード交換 → office発見 → oauth_tokensへ保存 → 設定画面へ戻す。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const back = (q: string) =>
    NextResponse.redirect(`${url.origin}/settings?${q}`);

  if (error) return back(`mf_error=${encodeURIComponent(error)}`);
  if (!code || !state) return back("mf_error=missing_code_or_state");

  // CSRF: cookieのstateと一致するか
  const cookieState = request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith("mf_oauth_state="))
    ?.slice("mf_oauth_state=".length);
  if (!cookieState || cookieState !== state) {
    return back("mf_error=state_mismatch");
  }

  const company = state.split(".")[1];
  if (company !== "nagi" && company !== "stadiums") {
    return back("mf_error=bad_state");
  }

  const redirectUri = `${url.origin}/api/mf/oauth/callback`;
  try {
    const { offices } = await exchangeCodeAndConnect(
      company as MfCompany,
      code,
      redirectUri
    );
    const res = back(
      `mf_connected=${company}&offices=${offices.length}`
    );
    res.cookies.delete("mf_oauth_state");
    return res;
  } catch (e) {
    return back(
      `mf_error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`
    );
  }
}
