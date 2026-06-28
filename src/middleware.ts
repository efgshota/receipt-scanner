import { NextResponse, type NextRequest } from "next/server";

/**
 * 簡易アクセス制御（Basic認証）。
 * BASIC_AUTH_USER と BASIC_AUTH_PASSWORD が両方セットされている時だけ有効化する。
 * 未設定ならスルー＝ローカル開発を邪魔しない。本番(Vercel)ではenvを設定して保護する。
 * 経費・レシート（金融データ）を扱うため、URLが漏れても素の閲覧/編集を防ぐ最低限の壁。
 */
export function middleware(req: NextRequest) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASSWORD;

  // 認証情報が無ければ保護無効（ローカル開発用）
  if (!user || !pass) return NextResponse.next();

  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const sep = decoded.indexOf(":");
      const u = decoded.slice(0, sep);
      const p = decoded.slice(sep + 1);
      if (u === user && p === pass) return NextResponse.next();
    } catch {
      // 不正なヘッダは下の401へフォールスルー
    }
  }

  return new NextResponse("認証が必要です", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="receipt-scanner", charset="UTF-8"',
    },
  });
}

// 静的アセットとファビコン以外の全リクエストに適用（APIも保護対象）
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon-192.png).*)"],
};
