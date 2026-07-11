# セットアップ手順 — 経費・請求ハブ

> 本番: https://receipt-scanner-flame.vercel.app （Basic認証）
> 稼働済み: Gmail自動取込（4アカウント）・日次バッチ（毎朝5時台JST）・サブスク/請求エンジン
> 残りのユーザー作業: **MFアプリ登録のみ**（下記。各10分程度・1回きり）

## 現在の自動化ループ

```
毎朝5時台（Vercel Cron）:
  1. サブスク定期生成    … recurring_rules から当月分を自動計上
  2. 請求書定期起票      … invoice_schedules からMFにドラフト作成（遅延なら赤バナー）
  3. MF自動提出          … 承認済みのサブスク経費をMFへ明細登録（証憑画像添付）
  4. メール領収書取込    … Gmail 4アカウント→Claude抽出→分類→レビュー行きor自動承認
```

手動実行: 設定ページ「今すぐ実行」/ `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/daily`

---

## A. MFクラウド経費 の接続（NAGI / stadiums 各社）

**A-1. アプリ登録（MF側・1回きり）**
1. 対象事業者に所属するMF IDで https://expense.moneyforward.com にログイン
2. 個人設定 → 基本設定 → **API連携（開発者向け）** → アプリケーション作成
3. リダイレクトURI: `https://receipt-scanner-flame.vercel.app/api/mf/oauth/callback`
   （httpsのみ許可。localhost不可）
4. 発行された **Client ID / Client Secret** を控える

**A-2. envに設定（Vercel）**
```
MF_NAGI_CLIENT_ID / MF_NAGI_CLIENT_SECRET         ← NAGI用
MF_STADIUMS_CLIENT_ID / MF_STADIUMS_CLIENT_SECRET ← stadiums用（同一MF IDが両事業者
                                                     所属なら同じアプリを流用可）
```
→ `vercel env add <NAME> production --scope efgshotas-projects` か、Claude Codeに依頼

**A-3. OAuth接続（アプリ側・ブラウザで完結）**
1. https://receipt-scanner-flame.vercel.app/settings を開く
2. 「MFクラウド経費 — NAGI」の **OAuth接続** → MFで承認
3. 事業者(office)と**経費科目**を選択 → 「接続済み」バッジになれば完了
4. stadiums も同様

> 補足: 旧 tokens.json のrefresh_tokenがまだ生きている場合は
> `set -a && . ./.env && set +a && npx tsx scripts/migrate-mf-tokens.ts`
> で再認可なしにDB移行できる（A-2のenvが先に必要）

## B. MFクラウド請求書 の接続（NAGI）

**B-1. アプリ登録（1回きり）**
1. NAGI事業者でクラウド請求書が利用可能なことを確認（MFクラウドのプランに含まれる）
2. API利用規約に同意 → **アプリポータル** https://app-portal.moneyforward.com/apps/ で新規登録
   - リダイレクトURI: `https://receipt-scanner-flame.vercel.app/api/mf-invoice/oauth/callback`
   - クライアント認証方式: **CLIENT_SECRET_BASIC**
3. Client ID / Client Secret を控える

**B-2. env**: `MF_INVOICE_CLIENT_ID` / `MF_INVOICE_CLIENT_SECRET`（production）

**B-3. 接続**: 設定ページ →「MFクラウド請求書」の OAuth接続 → 事業者を選択して承認

**B-4. 取引先の紐付け**: 請求ページ → 取引先を追加 → 「MF取引先を読込」→ 紐付け
（MF側に取引先が無ければ先にMF UIで作成。自動起票には紐付けが必須）

## C. 運用開始チェックリスト

- [ ] サブスクルール登録（設定ページ）: Anthropic / Google Workspace / Adobe / Figma / Vercel など
      「履歴からの候補」ボタン or 手動追加。autoSubmit=ON でMF提出まで全自動
- [ ] 定期請求スケジュール登録（請求ページ）: 顧問料など毎月発行するもの
- [ ] バックログ182件のレビュー: ダッシュボード「要レビュー順」で上から処理

## 環境変数一覧（Vercel production）

| 変数 | 状態 | 用途 |
|---|---|---|
| POSTGRES_URL / ANTHROPIC_API_KEY / BLOB_READ_WRITE_TOKEN | ✅設定済 | DB / OCR / 証憑保存 |
| BASIC_AUTH_USER / BASIC_AUTH_PASSWORD | ✅設定済 | アクセス制御 |
| GMAIL_ACCOUNTS / GMAIL_CREDENTIALS_{PERSONAL,STADIUMS,ZAPASS,TTNE} | ✅設定済 | メール取込（today101と共用） |
| CRON_SECRET | ✅設定済 | cron認証 |
| MF_NAGI_CLIENT_ID/SECRET | ⬜ A-2 | MF経費 NAGI |
| MF_STADIUMS_CLIENT_ID/SECRET | ⬜ A-2 | MF経費 stadiums |
| MF_INVOICE_CLIENT_ID/SECRET | ⬜ B-2 | MF請求書 |

## 障害時の見方

- 異常（トークン失効・cron失敗）は**ダッシュボード上部の赤バナー**に出る（Vercelのログは1時間で消えるためDBに記録）
- Gmailの認証が死ぬのは基本「Googleパスワード変更時」のみ → today101側で再取得して両方のenvを更新
- メール取込の判定履歴は 設定ページ最下部の取込ログで確認できる
- MF提出は「承認済み」の取引のみ・二重送信は自動ブロック（mfTransactionId）

## 設計メモ（変更時の注意）

- MFのrefresh_tokenは**使い捨てローテーション** → トークンはDB(oauth_tokens)のみで管理。tokens.json方式に戻さない
- 経費「申請」作成APIは存在しない → 自動化は明細登録+証憑添付まで。申請へのまとめはMF UI
- 請求書作成は `POST /invoice_template_billings` のみ（旧 /billings は2025-03廃止）。宛先は partner_id ではなく **department_id**
- Gmail検索で `{}` はOR演算子。クエリ変更時は必ずGmail UIで実クエリを試すこと
- cronフェーズは全て照合ベース冪等。「今日の分」ではなく「未処理を全部」で書く
