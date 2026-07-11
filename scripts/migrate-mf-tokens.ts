/**
 * tokens.json（旧ファイル保存）の MF経費トークンを oauth_tokens テーブルへ移行する。
 * 使い方: set -a && . ./.env && set +a && npx tsx scripts/migrate-mf-tokens.ts
 *
 * - refresh_token が生きていれば新トークンに更新してDB保存
 * - invalid_grant なら再認可が必要な旨を表示（設定画面のOAuth接続ボタンから）
 * - トークン値はログに出さない
 */
import fs from "fs";
import path from "path";

// .env 手動ロード（insert-mf-family.ts と同じ流儀）
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const [key, ...vals] = line.split("=");
    if (key && vals.length && !key.startsWith("#")) {
      process.env[key.trim()] = process.env[key.trim()] ?? vals.join("=").trim();
    }
  }
}

async function main() {
  const tokensPath = path.join(process.cwd(), "tokens.json");
  if (!fs.existsSync(tokensPath)) {
    console.log("tokens.json がありません。移行対象なし。");
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as Record<
    string,
    { refresh_token?: string } | undefined
  >;

  const { saveToken } = await import("../src/lib/integrations/token-store");

  for (const company of ["nagi", "stadiums"] as const) {
    const t = parsed[company];
    if (!t?.refresh_token) {
      console.log(`- ${company}: tokens.json にトークンなし（スキップ）`);
      continue;
    }
    const prefix = company === "nagi" ? "MF_NAGI" : "MF_STADIUMS";
    const clientId = process.env[`${prefix}_CLIENT_ID`];
    const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) {
      console.log(
        `- ${company}: ${prefix}_CLIENT_ID/SECRET 未設定のため移行できません。` +
          `.env に設定後に再実行してください`
      );
      continue;
    }

    console.log(`- ${company}: refresh_token でトークン更新を試行...`);
    const res = await fetch("https://expense.moneyforward.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.log(
        `  ✗ 更新失敗 (${res.status})。invalid_grant の場合は再認可が必要です` +
          `（本番の 設定 > MFクラウド経費 > OAuth接続 から）`
      );
      console.log(`  detail: ${body.slice(0, 150)}`);
      continue;
    }

    const nt = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope?: string;
    };

    // offices 発見
    const officesRes = await fetch(
      "https://expense.moneyforward.com/api/external/v1/offices",
      { headers: { Authorization: `Bearer ${nt.access_token}` } }
    );
    let offices: { id: string; name: string }[] = [];
    if (officesRes.ok) {
      const data = (await officesRes.json()) as {
        offices?: { id: string | number; name?: string }[];
      };
      const list = Array.isArray(data) ? data : (data.offices ?? []);
      offices = (list as { id: string | number; name?: string }[]).map((o) => ({
        id: String(o.id),
        name: o.name ?? String(o.id),
      }));
    }
    const envOfficeId = process.env[`${prefix}_OFFICE_ID`];
    const officeId =
      envOfficeId && offices.some((o) => o.id === envOfficeId)
        ? envOfficeId
        : offices.length === 1
          ? offices[0].id
          : (envOfficeId ?? null);

    await saveToken(
      company === "nagi" ? "mf_expense:nagi" : "mf_expense:stadiums",
      {
        accessToken: nt.access_token,
        refreshToken: nt.refresh_token,
        scope: nt.scope ?? null,
        expiresInSec: nt.expires_in,
      },
      { offices, officeId, defaultExItemId: null }
    );
    console.log(
      `  ✓ DB保存完了。offices=${offices.map((o) => o.name).join(",") || "取得失敗"} officeId=${officeId ?? "未選択"}`
    );
    console.log(
      `  次: 設定画面で経費科目(ex_item)を選択すると提出可能になります`
    );
  }

  console.log(
    "\n移行完了。tokens.json は不要になったら手動で削除してください（rm tokens.json）"
  );
}

main().catch((e) => {
  console.error("migration failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
