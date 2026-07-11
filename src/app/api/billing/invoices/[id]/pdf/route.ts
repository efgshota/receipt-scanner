import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fetchPdf } from "@/lib/integrations/mf-invoice-api";

/**
 * 請求書PDFプロキシ。MFのpdf_urlはBearer必須でブラウザ直リンク不可のため、
 * サーバ側でトークン付き取得して返す。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv) {
    return NextResponse.json({ error: "請求書が見つかりません" }, { status: 404 });
  }
  if (!inv.mfPdfUrl) {
    return NextResponse.json(
      { error: "MF未作成のためPDFがありません" },
      { status: 404 }
    );
  }
  try {
    const buf = await fetchPdf(inv.mfPdfUrl);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="invoice-${id.slice(0, 8)}.pdf"`,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
