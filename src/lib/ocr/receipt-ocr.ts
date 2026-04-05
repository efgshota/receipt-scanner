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
  "currency": "JPY"
}

注意:
- 金額は税込の合計金額を整数で
- 日付が不明な場合は空文字列
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
