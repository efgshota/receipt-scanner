import Anthropic from "@anthropic-ai/sdk";
import type { Bucket, Classification } from "@/lib/types";

const client = new Anthropic();

interface TransactionContext {
  vendor: string;
  amount: number;
  date: string;
  description: string;
}

export async function classifyWithClaude(
  tx: TransactionContext
): Promise<Classification> {
  const prompt = `あなたは経費仕分けAIです。以下の取引をNAGI株式会社（個人会社）、stadiums株式会社（勤め先）、family（家族）のいずれかに分類してください。

判断基準:
- NAGI: 個人事業・フリーランス的な経費（サブスク、ツール、個人的な業務）
- stadiums: 会社の業務経費（THE PERSON撮影、TOTOPA案件、チーム関連）
- family: 家族での利用（週末の外食、旅行、プライベート）

取引情報:
- 店舗/サービス: ${tx.vendor}
- 金額: ¥${tx.amount.toLocaleString()}
- 日付: ${tx.date}
- 備考: ${tx.description}

以下のJSON形式で回答してください:
{"bucket": "nagi" | "stadiums" | "family", "confidence": 0.0-1.0, "reason": "判断理由"}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        bucket: result.bucket as Bucket,
        confidence: Math.min(result.confidence * 0.7, 0.7), // Cap at 0.7 for Claude fallback
        reason: "claude",
        details: result.reason,
      };
    }
  } catch {
    // Parse failed
  }

  return {
    bucket: "nagi",
    confidence: 0.3,
    reason: "claude_fallback_failed",
    details: "Claude classification failed, defaulting to NAGI",
  };
}
