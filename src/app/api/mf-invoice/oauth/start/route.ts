import { NextResponse } from "next/server";
import crypto from "crypto";
import { buildInvoiceAuthorizeUrl } from "@/lib/integrations/mf-invoice-api";

/** MFクラウド請求書 OAuth開始（api.biz.moneyforward.com 系）。 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/mf-invoice/oauth/callback`;
  const state = crypto.randomBytes(16).toString("hex");

  let authorizeUrl: string;
  try {
    authorizeUrl = buildInvoiceAuthorizeUrl(redirectUri, state);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 }
    );
  }

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set("mf_invoice_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/mf-invoice/oauth",
  });
  return res;
}
