import type { Bucket } from "@/lib/types";

interface FixedRule {
  patterns: string[];
  bucket: Bucket;
}

const FIXED_RULES: FixedRule[] = [
  // === NAGI ===
  { patterns: ["google workspace", "google cloud"], bucket: "nagi" },
  { patterns: ["squarespace"], bucket: "nagi" },
  { patterns: ["anthropic", "claude"], bucket: "nagi" },
  { patterns: ["itunes", "apple", "applecare"], bucket: "nagi" },
  { patterns: ["kabwand"], bucket: "nagi" },
  { patterns: ["sakura internet", "さくらインターネット"], bucket: "nagi" },
  { patterns: ["suica", "スイカ"], bucket: "nagi" },
  { patterns: ["starbucks", "スターバックス"], bucket: "nagi" },
  { patterns: ["moom", "ムームー", "ムームードメイン"], bucket: "nagi" },
  { patterns: ["deepl"], bucket: "nagi" },

  // === stadiums ===
  { patterns: ["figma"], bucket: "stadiums" },
  { patterns: ["chatwork", "チャットワーク"], bucket: "stadiums" },
  {
    patterns: ["runners park", "runners park tokyo", "ランナーズパーク"],
    bucket: "stadiums",
  },
  { patterns: ["studio inc", "studio inc."], bucket: "stadiums" },
];

const TRANSPORT_VENDORS = [
  "etc",
  "タクシー",
  "taxi",
  "go株式会社",
  "kmグループ",
  "グリーンキャブ",
  "国際自動車",
  "三和交通",
  "新幹線",
  "jr ",
  "東海道新幹線",
  "えきねっと",
];

export function applyFixedRules(
  vendor: string,
  metadata?: { vercelAccountId?: string }
): { bucket: Bucket; confidence: number } | null {
  const vendorLower = vendor.toLowerCase();

  // Vercel: account-based routing
  if (vendorLower.includes("vercel")) {
    if (metadata?.vercelAccountId === "sfujii-8453") {
      return { bucket: "stadiums", confidence: 1.0 };
    }
    return { bucket: "nagi", confidence: 1.0 };
  }

  // Check fixed rules
  for (const rule of FIXED_RULES) {
    for (const pattern of rule.patterns) {
      if (vendorLower.includes(pattern.toLowerCase())) {
        return { bucket: rule.bucket, confidence: 1.0 };
      }
    }
  }

  return null;
}

export function isTransportVendor(vendor: string): boolean {
  const vendorLower = vendor.toLowerCase();
  return TRANSPORT_VENDORS.some((t) => vendorLower.includes(t.toLowerCase()));
}
