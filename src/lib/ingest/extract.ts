import Anthropic from "@anthropic-ai/sdk";

/**
 * メール（本文テキスト / PDF添付 / 画像添付）から領収書情報を抽出する。
 * 「領収書・支払確認メールか否か」の判定もClaudeに任せ、検索クエリの誤検知を弾く。
 */

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

export interface EmailReceiptExtraction {
  isReceipt: boolean;
  vendor: string;
  amount: number;
  date: string; // YYYY-MM-DD or ""
  description: string;
  invoiceNumber: string | null;
  confidence: number; // 0-1
  reasoning: string;
}

const PROMPT = `あなたは経費精算システムの取込エンジンです。このメールが「支払いの証跡（領収書/レシート/支払完了通知/利用明細）」かどうかを判定し、該当する場合は情報を抽出してください。

以下のJSON形式のみで回答:
{
  "is_receipt": true/false,
  "vendor": "店舗名またはサービス名（例: Anthropic, Google Workspace, GO）",
  "amount": 支払金額（税込・整数・円。USD等の外貨なら円換算せずその数値、currencyに通貨を記載）,
  "currency": "JPY",
  "date": "YYYY-MM-DD（支払日/利用日。不明なら空文字）",
  "description": "内容の簡潔な説明（プラン名・期間など）",
  "invoice_number": "T+13桁のインボイス登録番号（あれば、なければnull）",
  "confidence": 0.0-1.0,
  "reasoning": "判定根拠を一言"
}

【is_receipt = false にすべきもの】
- 請求予告・支払いリマインダー（まだ支払っていない）
- マーケティング/ニュースレター
- 注文確認のみで金額未確定のもの
- サブスクの更新予告

【is_receipt = true のもの】
- 領収書・レシート添付/記載
- 「お支払いが完了しました」「Payment received」「Your receipt」
- クレジットカード決済完了通知（金額確定）

【金額】小数のある外貨はそのままの数値でamountに（例: $20.00 → 20）。currencyを正確に。`;

type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

function toImageMediaType(mt: string | null | undefined): ImageMediaType {
  if (mt === "image/png" || mt === "image/webp" || mt === "image/gif") return mt;
  return "image/jpeg";
}

type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: ImageMediaType; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    };

export async function extractReceiptFromEmail(input: {
  subject: string;
  from: string;
  bodyText: string;
  pdfBase64?: string | null;
  imageBase64?: string | null;
  imageMediaType?: string | null;
}): Promise<EmailReceiptExtraction> {
  const content: ContentBlock[] = [];

  if (input.pdfBase64) {
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: input.pdfBase64,
      },
    });
  } else if (input.imageBase64) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: toImageMediaType(input.imageMediaType),
        data: input.imageBase64,
      },
    });
  }

  content.push({
    type: "text",
    text: `${PROMPT}

--- メール情報 ---
From: ${input.from}
Subject: ${input.subject}

--- 本文 ---
${input.bodyText.slice(0, 8000)}`,
  });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    messages: [{ role: "user", content }],
  });

  const text =
    response.content[0]?.type === "text" ? response.content[0].text : "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("メール抽出: JSON形式の応答を取得できませんでした");
  }
  const p = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

  const currency = String(p.currency ?? "JPY").toUpperCase();
  let amount = Math.round(Number(p.amount ?? 0));
  // 外貨は概算円換算せず、金額そのまま + descriptionに通貨注記（レビューで確認）
  let description = String(p.description ?? "");
  if (currency !== "JPY" && amount > 0) {
    description = `${description}（${currency} ${p.amount}・要円換算確認）`;
    amount = 0; // 円額不明のため0にして要確認フローへ
  }

  return {
    isReceipt: Boolean(p.is_receipt),
    vendor: String(p.vendor ?? "Unknown"),
    amount,
    date: String(p.date ?? ""),
    description,
    invoiceNumber: p.invoice_number ? String(p.invoice_number) : null,
    confidence: Math.max(0, Math.min(1, Number(p.confidence ?? 0))),
    reasoning: String(p.reasoning ?? ""),
  };
}
