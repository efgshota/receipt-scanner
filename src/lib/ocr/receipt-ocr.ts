import Anthropic from "@anthropic-ai/sdk";
import type { OcrResult } from "@/lib/types";
import { lookupInvoiceNumber } from "@/lib/utils/vendor-db";

const client = new Anthropic();

export async function extractReceiptData(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg"
): Promise<OcrResult> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageBase64 },
          },
          {
            type: "text",
            text: `このレシート/領収書の情報を抽出してください。以下のJSON形式で回答してください:

{
  "vendor": "店舗名またはサービス名",
  "amount": 金額（税込、整数、円単位）,
  "date": "YYYY-MM-DD形式の日付",
  "description": "内容の簡潔な説明",
  "invoiceNumber": "T+13桁のインボイス登録番号（あれば）",
  "currency": "JPY",
  "dateConfidence": "high|medium|low",
  "dateReasoning": "日付をどう判定したかの根拠（和暦・西暦の判別など）"
}

【金額の注意】
- 金額は税込の合計金額（支払額）を整数で
- 駐車券などに印字された券番号（例: No.253195）を金額と誤認しないこと
- 「合計」「お支払い」「現計」「税込」表記の金額を採用

【日付の厳重チェック - 最重要】
- レシートの撮影は2025年以降のもののみ。**2024年以前と読み取れた場合は再確認すること**
- 和暦表記に注意:
  - 令和 = 2019年〜（例: 令和6年 = 2024年、令和7年 = 2025年、令和8年 = 2026年）
  - 平成 = 1989〜2019年（古いレシートでない限り通常出現しない）
  - 「R06」「R7」のような略記もある
- 「26-03-06」のような短縮表記は曖昧:
  - 「26」が令和か西暦かを文脈で判断
  - 令和なら 令和26年=2044年（未来）→ありえない
  - 西暦なら 2026年 → 妥当
  - 「R26」「H26」など元号略記が併記されていれば確実
- 年が明示されていない（月/日のみ）場合は空文字列を返す
- 不明確な場合は dateConfidence: "low" として **dateReasoning** に根拠を書く

【その他】
- インボイス番号がない場合はnull
- 店舗名は正式名称で`,
          },
        ],
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("OCR: Failed to extract structured data from receipt");
  }

  const parsed = JSON.parse(jsonMatch[0]);

  // Look up invoice number from vendor DB if not found on receipt
  const invoiceNumber =
    parsed.invoiceNumber || lookupInvoiceNumber(parsed.vendor);

  return {
    vendor: parsed.vendor || "Unknown",
    amount: Math.round(parsed.amount || 0),
    date: parsed.date || "",
    description: parsed.description || "",
    invoiceNumber,
    currency: parsed.currency || "JPY",
    raw: parsed,
  };
}
