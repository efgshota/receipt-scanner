import { NextResponse } from "next/server";
import { exchangeInvoiceCode } from "@/lib/integrations/mf-invoice-api";

/** MFクラウド請求書 OAuthコールバック。 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const back = (q: string) =>
    NextResponse.redirect(`${url.origin}/settings?${q}`);

  if (error) return back(`mfi_error=${encodeURIComponent(error)}`);
  if (!code || !state) return back("mfi_error=missing_code_or_state");

  const cookieState = request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith("mf_invoice_oauth_state="))
    ?.slice("mf_invoice_oauth_state=".length);
  if (!cookieState || cookieState !== state) {
    return back("mfi_error=state_mismatch");
  }

  const redirectUri = `${url.origin}/api/mf-invoice/oauth/callback`;
  try {
    await exchangeInvoiceCode(code, redirectUri);
    const res = back("mfi_connected=1");
    res.cookies.delete("mf_invoice_oauth_state");
    return res;
  } catch (e) {
    return back(
      `mfi_error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`
    );
  }
}
