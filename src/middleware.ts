import { NextResponse, type NextRequest } from "next/server";

/** タイミングセーフな文字列比較（Edge Runtimeにはcrypto.timingSafeEqualが無いためXOR実装） */
function timingSafeEq(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % Math.max(1, ab.length)] ?? 0) ^ (bb[i % Math.max(1, bb.length)] ?? 0);
  }
  return diff === 0;
}

/**
 * 簡易アクセス制御（Basic認証）。
 * BASIC_AUTH_USER と BASIC_AUTH_PASSWORD が両方セットされている時だけ有効化する。
 * 未設定ならスルー＝ローカル開発を邪魔しない。本番(Vercel)ではenvを設定して保護する。
 * 経費・レシート（金融データ）を扱うため、URLが漏れても素の閲覧/編集を防ぐ最低限の壁。
 */
export function middleware(req: NextRequest) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASSWORD;

  // Vercel Cron は Authorization: Bearer <CRON_SECRET> を付与してくる。
  // Basic認証と同一ヘッダを奪い合うため、Bearer一致で通すのは cron と
  // サーバー間取込（Mac miniの写真自動取込 = /api/receipts/upload）のみ。
  // （CRON_SECRET未設定時はこの分岐自体が無効＝fail-closed）
  const path = req.nextUrl.pathname;
  if (path.startsWith("/api/cron/") || path === "/api/receipts/upload") {
    const cronSecret = process.env.CRON_SECRET;
    const header = req.headers.get("authorization");
    if (cronSecret && header && timingSafeEq(header, `Bearer ${cronSecret}`)) {
      return NextResponse.next();
    }
    // Bearer不一致でも、Basic認証ユーザーの手動実行は下の通常フローで許可される
  }

  // 認証情報が無い場合の挙動:
  // - Vercel上（本番/プレビュー）では fail-closed で遮断＝未保護のまま金融データを晒さない
  // - ローカル(VERCEL未設定)では素通し＝開発を邪魔しない
  if (!user || !pass) {
    if (process.env.VERCEL) {
      return new NextResponse(
        "アクセス制御が未設定のため停止中（BASIC_AUTH_USER/PASSWORD を設定してください）",
        { status: 503 }
      );
    }
    return NextResponse.next();
  }

  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const sep = decoded.indexOf(":");
      const u = decoded.slice(0, sep);
      const p = decoded.slice(sep + 1);
      if (timingSafeEq(u, user) && timingSafeEq(p, pass)) {
        return NextResponse.next();
      }
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
