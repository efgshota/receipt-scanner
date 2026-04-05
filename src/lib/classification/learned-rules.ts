import { db } from "@/lib/db";
import { corrections, vendorRules } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import type { Bucket } from "@/lib/types";

export async function applyLearnedRules(
  vendor: string
): Promise<{ bucket: Bucket; confidence: number } | null> {
  // Check vendor_rules for learned patterns
  const rules = await db
    .select()
    .from(vendorRules)
    .where(eq(vendorRules.ruleType, "learned"));

  const vendorLower = vendor.toLowerCase();
  for (const rule of rules) {
    if (vendorLower.includes(rule.vendorPattern.toLowerCase())) {
      return {
        bucket: rule.bucket,
        confidence: rule.confidence,
      };
    }
  }

  // Check correction history for patterns
  const correctionStats = await db
    .select({
      vendorPattern: corrections.vendorPattern,
      correctedBucket: corrections.correctedBucket,
      count: sql<number>`count(*)::int`,
    })
    .from(corrections)
    .groupBy(corrections.vendorPattern, corrections.correctedBucket);

  for (const stat of correctionStats) {
    if (vendorLower.includes(stat.vendorPattern.toLowerCase())) {
      // 3+ consistent corrections = high confidence learned rule
      if (stat.count >= 3) {
        return { bucket: stat.correctedBucket, confidence: 0.95 };
      }
      if (stat.count >= 1) {
        return { bucket: stat.correctedBucket, confidence: 0.8 };
      }
    }
  }

  return null;
}

export async function recordCorrection(
  transactionId: string,
  originalBucket: Bucket,
  correctedBucket: Bucket,
  vendorPattern: string
) {
  await db.insert(corrections).values({
    transactionId,
    originalBucket,
    correctedBucket,
    vendorPattern: vendorPattern.toLowerCase(),
  });

  // Check if we should promote to a fixed learned rule
  const stats = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(corrections)
    .where(eq(corrections.vendorPattern, vendorPattern.toLowerCase()));

  if (stats[0] && stats[0].count >= 3) {
    // Upsert a learned vendor rule
    await db
      .insert(vendorRules)
      .values({
        vendorPattern: vendorPattern.toLowerCase(),
        bucket: correctedBucket,
        ruleType: "learned",
        confidence: 0.95,
        correctionCount: stats[0].count,
      })
      .onConflictDoNothing();
  }
}
