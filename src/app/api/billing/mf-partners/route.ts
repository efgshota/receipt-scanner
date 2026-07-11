import { NextResponse } from "next/server";
import { listPartners } from "@/lib/integrations/mf-invoice-api";

/** MF請求書の取引先一覧（billing_clients との紐付けUI用） */
export async function GET() {
  try {
    const partners = await listPartners();
    return NextResponse.json({ partners });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
