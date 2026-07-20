# 経費・請求ハブ 運用マニュアル（最終版）

> 本番: https://receipt-scanner-flame.vercel.app （Basic認証: shota / Vercel env管理）
> 方針: **MFのAPI連携は使わない**（アプリポータル管理者=会計事務所のため登録不可）。
> ハブが収集・整理・確定まで自動で行い、MFへは「取込用ファイル」で渡す。

## 全体像 — どこが自動で、どこが手動か

```
【全自動・毎朝5時台】
  Gmail 4アカウント巡回（personal / stadiums / zapass / ttne）
    └ 領収書メール・添付PDF・一括発行メール（GO等）・Stripe系ペア重複排除
  IMAP巡回（efg@nagi-inc.jp = 自社サーバ）
    └ アライブ株式会社のサーバー費用 領収書PDF（毎月25日頃着）
  サブスク定期計上（アライブ ¥17,600 / Anthropic Max ≒¥33,000 ほかルール登録分）
  請求書の発行期日管理（遅延は赤バナー）

【半自動・任意のタイミング】
  iCloud写真「領収書」アルバム → `npx tsx scripts/import-photos.ts`（Mac mini）
  /upload ページ: 画像・PDFのドラッグ&ドロップ（PDF請求書もOK）

【人間の仕事（月1回・15分想定）】
  1. ダッシュボードでレビュー＆承認
  2. エクスポートしてMFへ（下記ルート）
  3. 「提出済」マーク
```

## 月次ルーチン（これだけやればいい）

### ① レビュー（ダッシュボード）
- 「要レビュー順」で上から確認。データは毎晩の取込時にAI照合済みなので、
  基本は**中身が経費として妥当かの判断だけ**
- ⚠付き（日付なし・¥0・¥10万超・重複疑い・金額変動）は目視必須
- バケツ間違いはその場で変更（学習されて次回から自動振り分け）
- 経費にしないものは「却下」

### ② 承認 → エクスポート → MFへ

**stadiums分（会社のMFクラウド経費に申請）**
1. stadiums行の「一括承認」→「画像ZIP」をダウンロード
   - ファイル名は `日付_店名_金額.jpg` になっている
2. 会社のMFクラウド経費にログイン → 領収書アップロード（AI-OCRが明細化）
   またはCSVを見ながら明細入力
3. ハブで「手動で提出済」を押す

**NAGI分（MF会計に直接仕訳で入れる）**
1. nagi行の「一括承認」→「**MF仕訳CSV**」をダウンロード
   - MF会計「仕訳帳インポート」公式フォーマット（借方=科目自動判定/貸方=役員借入金）
   - 科目が自動判定できなかった行は「雑費＋要確認メモ」付き
2. MF会計 → 会計帳簿 → 仕訳帳 → インポート → 仕訳帳 → このCSV
3. 証憑は「画像ZIP」をMF会計のファイルボックスへ（または保管はハブに任せる）
4. ハブで「手動で提出済」を押す

> 貸方科目を変えたい場合: `/api/transactions/export-mf?bucket=nagi&status=approved&credit=未払金`

**family分**: CSV+画像ZIPで家計側の管理へ（会社経費とは無関係）

### ③ 請求書（見積書）の発行
- MF請求書APIは使えないため、**発行はMFのUIで手動**
- ハブの請求ページは「期日管理」に使う: スケジュール登録しておくと
  発行が遅れた月はダッシュボードに赤バナーが出る → MF UIで発行 → 「送付済に」でクリア

## 自動取込の対象（登録済み）

| ソース | 対象 | 備考 |
|---|---|---|
| Gmail(personal) | GO一括発行・Anthropic・Vercel(個人)・STORES/TOTOPA・その他領収書メール | 件名ベース＋Claude判定 |
| Gmail(stadiums) | Vercel(THE PERSONチーム)ほか | |
| Gmail(zapass/ttne) | 同上 | ttneは再認証が必要になったらdocs下部参照 |
| IMAP(efg@nagi-inc.jp) | アライブのサーバー費用（alive-web.co.jp送信分のみ） | 毎月25日頃・自動 |
| 定期ルール | アライブ ¥17,600(25日) / Anthropic ≒¥33,000(7日) | メール実物が来たら自動紐付け |
| 写真アルバム | iCloud「領収書」アルバム | `RECEIPT_SCANNER_URL=https://receipt-scanner-flame.vercel.app RECEIPT_SCANNER_AUTH=shota:<PW> npx tsx scripts/import-photos.ts` |

**取込対象を増やしたいとき**: 新しいサービスの領収書メールが件名条件（領収書/receipt/invoice/請求/決済…）に合えば自動で入る。合わない場合はバックフィル
`/api/cron/daily?only=ingest&days=N&q=<Gmail検索式>` を叩くか、Claudeに依頼。

## 除外ルール
- **Meta広告**: 精算対象外（本人指示 2026-07-11）。取込前に自動スキップ
- 追加除外は env `INGEST_EXCLUDE_PATTERNS`（カンマ区切り）

## 障害時の見方
- 異常（トークン失効・cron失敗）は**ダッシュボード上部の赤バナー**
- Gmail認証失効: `python3 <scratchpad>/get_<name>_token.py` 方式で再取得
  （today101/system/credentials.json のOAuthクライアントを使用）→
  Vercel env `GMAIL_CREDENTIALS_<NAME>` と today101側 `.env` の両方を更新
- IMAP失効: メールボックスのパスワード変更時のみ。`IMAP_CREDENTIALS_NAGI` を更新
- 取込判定の履歴: 設定ページ最下部の取込ログ
- 取込やり直し: `POST /api/ingest/reprocess {account, messageId}`（提出済みは保護）

## 環境変数（Vercel production）

| 変数 | 用途 |
|---|---|
| POSTGRES_URL / ANTHROPIC_API_KEY / BLOB_READ_WRITE_TOKEN | DB / AI照合 / 証憑保存 |
| BASIC_AUTH_USER / BASIC_AUTH_PASSWORD | アクセス制御 |
| GMAIL_ACCOUNTS / GMAIL_CREDENTIALS_* | Gmail取込 |
| IMAP_ACCOUNTS / IMAP_CREDENTIALS_NAGI | IMAP取込（アライブ） |
| CRON_SECRET | cron認証 |
| INGEST_EXCLUDE_PATTERNS（任意） | 追加除外 |

## 設計メモ（変更時の注意）
- MFのAPI連携コード（mf-expense-api / mf-invoice-api）は残置だが**未接続・接続予定なし**
- 経費データの流れ: 取込 → pending/classified → approved → submitted(手動マーク)。提出済はロック
- Gmail検索の `{}` はOR。クエリ変更時はGmail UIで必ず実クエリ確認
- cronフェーズは全て照合ベース冪等。「今日の分」ではなく「未処理を全部」
- Stripe系メールは Invoice-*.pdf / Receipt-*.pdf ペア → Receipt側のみ取込む実装済み
- USD建ては取込時¥0 + ECBレートで概算入力（摘要に明記）。確定はカード明細で
