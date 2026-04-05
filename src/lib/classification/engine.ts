import type { Classification } from "@/lib/types";
import { applyFixedRules, isTransportVendor } from "./fixed-rules";
import { applyLearnedRules } from "./learned-rules";
import { applyCalendarRules } from "./calendar-rules";
import { classifyWithClaude } from "./claude-fallback";

interface ClassifyInput {
  vendor: string;
  amount: number;
  date: string;
  description: string;
  metadata?: {
    vercelAccountId?: string;
  };
}

export async function classify(input: ClassifyInput): Promise<Classification> {
  // Step 1: Fixed rules (exact vendor match)
  const fixed = applyFixedRules(input.vendor, input.metadata);
  if (fixed) {
    return {
      bucket: fixed.bucket,
      confidence: fixed.confidence,
      reason: "fixed_rule",
      details: `Fixed rule: ${input.vendor} → ${fixed.bucket}`,
    };
  }

  // Step 2: Learned rules (from correction history)
  try {
    const learned = await applyLearnedRules(input.vendor);
    if (learned && learned.confidence >= 0.8) {
      return {
        bucket: learned.bucket,
        confidence: learned.confidence,
        reason: "learned",
        details: `Learned from past corrections: ${input.vendor} → ${learned.bucket}`,
      };
    }
  } catch {
    // DB not available, skip learned rules
  }

  // Step 3: Calendar rules (for transport/travel vendors)
  if (isTransportVendor(input.vendor)) {
    try {
      // TODO: Fetch actual calendar events via Google Calendar API
      const calResult = await applyCalendarRules(input.date);
      if (calResult) {
        return {
          bucket: calResult.bucket,
          confidence: calResult.confidence,
          reason: "calendar",
          details: calResult.details,
        };
      }
    } catch {
      // Calendar not available
    }
  }

  // Step 4: Claude fallback (for ambiguous cases)
  try {
    return await classifyWithClaude({
      vendor: input.vendor,
      amount: input.amount,
      date: input.date,
      description: input.description,
    });
  } catch {
    // Claude not available, use default
  }

  // Final fallback: default to NAGI with low confidence
  return {
    bucket: "nagi",
    confidence: 0.3,
    reason: "default",
    details: "No rule matched, defaulting to NAGI",
  };
}
