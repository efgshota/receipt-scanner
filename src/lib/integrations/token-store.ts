import { db } from "@/lib/db";
import { oauthTokens, systemAlerts } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";

/**
 * 外部サービスOAuthトークンのDB管理。
 *
 * 背景:
 * - Vercelサーバレスではファイル(tokens.json)書込が永続しないためDB保存が必須
 * - MF系APIのリフレッシュトークンは「使い捨てローテーション」（更新のたびに新しい
 *   refresh_tokenが返り、旧refresh_tokenは無効化される）
 * - neon-httpドライバはトランザクション(SELECT FOR UPDATE)非対応のため、
 *   並行リフレッシュの直列化は CAS（refresh_token旧値一致時のみUPDATE）で行う。
 *   CAS負け＝他インスタンスが更新済み → 再読込して新トークンをそのまま使う。
 */

export type TokenProvider =
  | "mf_expense:nagi"
  | "mf_expense:stadiums"
  | "mf_invoice:nagi";

export interface StoredToken {
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  expiresAt: Date | null;
  meta: Record<string, unknown> | null;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string | null;
  scope?: string | null;
  expiresInSec?: number | null;
}

function rowToToken(r: typeof oauthTokens.$inferSelect): StoredToken {
  return {
    provider: r.provider,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    scope: r.scope,
    expiresAt: r.expiresAt,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
  };
}

export async function getStoredToken(
  provider: TokenProvider
): Promise<StoredToken | null> {
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.provider, provider));
  return row ? rowToToken(row) : null;
}

/** 接続時（OAuth callback）の保存。既存行は上書き。metaはマージせず置換。 */
export async function saveToken(
  provider: TokenProvider,
  t: RefreshResult,
  meta?: Record<string, unknown>
): Promise<void> {
  const expiresAt = t.expiresInSec
    ? new Date(Date.now() + t.expiresInSec * 1000)
    : null;
  const values = {
    provider,
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    scope: t.scope ?? null,
    expiresAt,
    meta: meta ?? null,
    updatedAt: new Date(),
  };
  await db
    .insert(oauthTokens)
    .values(values)
    .onConflictDoUpdate({
      target: oauthTokens.provider,
      set: {
        accessToken: values.accessToken,
        refreshToken: values.refreshToken,
        scope: values.scope,
        expiresAt: values.expiresAt,
        // metaを明示指定した時のみ置換（接続やり直しで office 情報を更新するケース）
        ...(meta !== undefined ? { meta: values.meta } : {}),
        updatedAt: values.updatedAt,
      },
    });
}

/** metaのみ更新（office選択・経費科目選択など） */
export async function updateTokenMeta(
  provider: TokenProvider,
  patch: Record<string, unknown>
): Promise<void> {
  const existing = await getStoredToken(provider);
  if (!existing) throw new Error(`${provider} は未接続です`);
  await db
    .update(oauthTokens)
    .set({ meta: { ...(existing.meta ?? {}), ...patch }, updatedAt: new Date() })
    .where(eq(oauthTokens.provider, provider));
}

export async function deleteToken(provider: TokenProvider): Promise<void> {
  await db.delete(oauthTokens).where(eq(oauthTokens.provider, provider));
}

/** 失効等の異常をダッシュボード用に記録（同種の未解決アラートは重複させない） */
export async function raiseAlert(kind: string, message: string): Promise<void> {
  try {
    const rows = await db
      .select({ id: systemAlerts.id })
      .from(systemAlerts)
      .where(
        and(
          eq(systemAlerts.kind, kind),
          eq(systemAlerts.message, message),
          isNull(systemAlerts.resolvedAt) // 解決済みは再発報を妨げない
        )
      );
    const unresolved = rows.length > 0;
    if (!unresolved) {
      await db.insert(systemAlerts).values({ kind, message });
    }
  } catch {
    // アラート記録の失敗で本処理を止めない
  }
}

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * 有効なアクセストークンを返す。期限切れ（5分バッファ）なら refresher でリフレッシュし、
 * CASでDBに書き戻す。CAS負け時は再読込して勝者のトークンを使う。
 *
 * refresher: 現在のrefresh_tokenを受け取り、新トークンを返す（providerごとのAPI差異を吸収）
 */
export async function getValidAccessToken(
  provider: TokenProvider,
  refresher: (refreshToken: string) => Promise<RefreshResult>
): Promise<{ accessToken: string; meta: Record<string, unknown> | null }> {
  const stored = await getStoredToken(provider);
  if (!stored) {
    throw new Error(
      `${provider} のトークンがありません。設定画面からOAuth接続してください`
    );
  }

  const isExpired =
    stored.expiresAt !== null &&
    Date.now() > stored.expiresAt.getTime() - EXPIRY_BUFFER_MS;

  if (!isExpired) {
    return { accessToken: stored.accessToken, meta: stored.meta };
  }

  if (!stored.refreshToken) {
    await raiseAlert(
      "token_expired",
      `${provider} のトークンが失効しrefresh_tokenもありません。設定画面から再接続してください`
    );
    throw new Error(`${provider} のトークンが失効しています（要再接続）`);
  }

  let refreshed: RefreshResult;
  try {
    refreshed = await refresher(stored.refreshToken);
  } catch (e) {
    // invalid_grant の可能性: 他インスタンスが先にローテーション済みかもしれないので再読込
    const latest = await getStoredToken(provider);
    if (
      latest &&
      latest.refreshToken !== stored.refreshToken &&
      latest.expiresAt &&
      Date.now() < latest.expiresAt.getTime() - EXPIRY_BUFFER_MS
    ) {
      return { accessToken: latest.accessToken, meta: latest.meta };
    }
    await raiseAlert(
      "token_expired",
      `${provider} のトークン更新に失敗しました。設定画面から再接続してください（${e instanceof Error ? e.message : String(e)}）`
    );
    throw e;
  }

  const expiresAt = refreshed.expiresInSec
    ? new Date(Date.now() + refreshed.expiresInSec * 1000)
    : null;

  // CAS: 自分が読んだrefresh_tokenのままの時だけ更新（ローテーションチェーン保護）
  const updated = await db
    .update(oauthTokens)
    .set({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? stored.refreshToken,
      scope: refreshed.scope ?? stored.scope,
      expiresAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(oauthTokens.provider, provider),
        eq(oauthTokens.refreshToken, stored.refreshToken)
      )
    )
    .returning({ provider: oauthTokens.provider });

  if (updated.length === 0) {
    // CAS負け: 勝者のトークンを使う
    const latest = await getStoredToken(provider);
    if (latest) return { accessToken: latest.accessToken, meta: latest.meta };
  }

  return { accessToken: refreshed.accessToken, meta: stored.meta };
}
