import { NextResponse } from "next/server";
import { updateTokenMeta } from "@/lib/integrations/token-store";
import { listExItems, type MfCompany } from "@/lib/integrations/mf-expense-api";

/**
 * MF経費の接続後設定。
 * POST { company, officeId? , defaultExItemId? } — office選択・デフォルト経費科目選択
 * GET  ?company=nagi — 選択可能な経費科目一覧
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const company = body?.company;
  if (company !== "nagi" && company !== "stadiums") {
    return NextResponse.json({ error: "company が不正です" }, { status: 400 });
  }
  const patch: Record<string, unknown> = {};
  if (typeof body.officeId === "string" && body.officeId) {
    patch.officeId = body.officeId;
  }
  if (typeof body.defaultExItemId === "string" && body.defaultExItemId) {
    patch.defaultExItemId = body.defaultExItemId;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "officeId か defaultExItemId を指定してください" },
      { status: 400 }
    );
  }
  try {
    await updateTokenMeta(
      company === "nagi" ? "mf_expense:nagi" : "mf_expense:stadiums",
      patch
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const company = searchParams.get("company");
  if (company !== "nagi" && company !== "stadiums") {
    return NextResponse.json({ error: "company が不正です" }, { status: 400 });
  }
  try {
    const items = await listExItems(company as MfCompany);
    return NextResponse.json({ exItems: items });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
