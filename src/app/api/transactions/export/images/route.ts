import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { desc, eq, and, isNotNull, type SQL } from "drizzle-orm";
import type { Bucket, TransactionStatus } from "@/lib/types";
import { buildZip, type ZipEntry } from "@/lib/utils/zip";
import fs from "fs";
import path from "path";

// ファイル名に使えない文字を除去（パス区切りも除去）
function sanitize(s: string): string {
  return s.replace(/[\/\\:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 40);
}

// URL/パスから安全な拡張子のみ取り出す（クエリ文字列・パス区切り混入を防ぐ）
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "pdf"]);
function safeExt(url: string): string {
  try {
    const pathname = url.startsWith("http")
      ? new URL(url).pathname
      : url.split("?")[0];
    const seg = pathname.split("/").pop() || "";
    const m = seg.match(/\.([a-z0-9]+)$/i);
    const e = m ? m[1].toLowerCase() : "";
    return ALLOWED_EXT.has(e) ? e : "jpg";
  } catch {
    return "jpg";
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const bucket = searchParams.get("bucket") as Bucket | null;
  const status = searchParams.get("status") as TransactionStatus | null;

  const filters: SQL[] = [isNotNull(transactions.receiptImageUrl)];
  if (bucket) filters.push(eq(transactions.bucket, bucket));
  if (status) filters.push(eq(transactions.status, status));

  const rows = await db
    .select()
    .from(transactions)
    .where(and(...filters))
    .orderBy(desc(transactions.date));

  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  let missing = 0;

  for (const r of rows) {
    const url = r.receiptImageUrl;
    if (!url) continue;

    let data: Buffer | null = null;
    const ext = safeExt(url);
    try {
      if (url.startsWith("http")) {
        const res = await fetch(url);
        if (!res.ok) {
          missing++;
          continue;
        }
        data = Buffer.from(await res.arrayBuffer());
      } else {
        const publicDir = path.join(process.cwd(), "public");
        const filePath = path.resolve(publicDir, "." + (url.startsWith("/") ? url : "/" + url));
        // パストラバーサル防止: public 配下に収まることを保証
        if (!filePath.startsWith(publicDir + path.sep) || !fs.existsSync(filePath)) {
          missing++;
          continue;
        }
        data = fs.readFileSync(filePath);
      }
    } catch {
      missing++;
      continue;
    }
    if (!data) continue;

    const datePart = r.date ?? "nodate";
    const base = `${datePart}_${sanitize(r.vendor)}_${r.amount}`;
    let name = `${base}.${ext}`;
    let i = 2;
    while (used.has(name)) {
      name = `${base}_${i}.${ext}`;
      i++;
    }
    used.add(name);
    entries.push({ name, data });
  }

  if (entries.length === 0) {
    return NextResponse.json(
      { error: "対象のレシート画像がありません" },
      { status: 404 }
    );
  }

  const zip = buildZip(entries);
  const label = bucket ?? "all";
  const filename = `receipts-${label}-${new Date().toISOString().slice(0, 10)}.zip`;

  // Buffer を Uint8Array にして返す（Response body 互換）
  return new NextResponse(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Receipt-Count": String(entries.length),
      "X-Missing-Count": String(missing),
    },
  });
}
