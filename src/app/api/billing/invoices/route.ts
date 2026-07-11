import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { billingClients, invoices } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import {
  createBilling,
  createQuote,
  getMfInvoiceStatus,
  type InvoiceItemInput,
} from "@/lib/integrations/mf-invoice-api";
import { computeDueDate } from "@/lib/billing/engine";

export async function GET() {
  const rows = await db
    .select({ invoice: invoices, clientName: billingClients.name })
    .from(invoices)
    .leftJoin(billingClients, eq(invoices.clientId, billingClients.id))
    .orderBy(desc(invoices.createdAt));
  return NextResponse.json({
    invoices: rows.map((r) => ({ ...r.invoice, clientName: r.clientName })),
  });
}

/**
 * 見積書/請求書を単発作成する（スケジュール外のスポット案件用）。
 * body: { kind: "invoice"|"quote", clientId, title, amount, issueDate?, memo?, items? }
 * MF接続済み+取引先にdepartment設定があればMFにも作成する。
 */
export async function POST(request: Request) {
  const b = await request.json().catch(() => ({}));
  const kind = b.kind === "quote" ? "quote" : "invoice";
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const amount = Number(b.amount);

  if (!b.clientId || !title) {
    return NextResponse.json(
      { error: "clientId / title は必須です" },
      { status: 400 }
    );
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return NextResponse.json(
      { error: "amount は正の整数（税抜）で指定してください" },
      { status: 400 }
    );
  }

  const issueDate =
    typeof b.issueDate === "string" && b.issueDate
      ? b.issueDate
      : new Date().toISOString().slice(0, 10);
  const dueDate = computeDueDate(issueDate, "end_of_next_month");
  const items: InvoiceItemInput[] = Array.isArray(b.items)
    ? b.items
    : [{ name: title, price: amount, quantity: 1 }];

  const [localInvoice] = await db
    .insert(invoices)
    .values({
      kind,
      status: "draft",
      clientId: b.clientId,
      title,
      amount,
      issueDate,
      dueDate,
      items,
      memo: typeof b.memo === "string" ? b.memo : null,
    })
    .returning();

  // MFへの作成を試行
  let mfError: string | null = null;
  const mfStatus = await getMfInvoiceStatus();
  if (mfStatus.configured) {
    const [client] = await db
      .select()
      .from(billingClients)
      .where(eq(billingClients.id, b.clientId));
    if (client?.mfDepartmentId) {
      try {
        const mf =
          kind === "quote"
            ? await createQuote({
                departmentId: client.mfDepartmentId,
                title,
                quoteDate: issueDate,
                expiredDate: dueDate,
                items,
                memo: localInvoice.memo ?? undefined,
              })
            : await createBilling({
                departmentId: client.mfDepartmentId,
                title,
                billingDate: issueDate,
                salesDate: issueDate,
                dueDate,
                items,
                memo: localInvoice.memo ?? undefined,
              });
        const [updated] = await db
          .update(invoices)
          .set({
            status: "created_in_mf",
            mfInvoiceId: mf.id,
            mfPdfUrl: mf.pdfUrl,
            updatedAt: new Date(),
          })
          .where(eq(invoices.id, localInvoice.id))
          .returning();
        return NextResponse.json({ invoice: updated });
      } catch (e) {
        mfError = e instanceof Error ? e.message : String(e);
      }
    } else {
      mfError = "取引先にMF部署(department)が未設定です";
    }
  } else {
    mfError = mfStatus.reason ?? "MF請求書未接続";
  }

  return NextResponse.json({ invoice: localInvoice, mfError });
}

// 請求書の正当な状態遷移（transactions の ALLOWED_FROM と同思想のサーバ側安全弁）
const INVOICE_ALLOWED_FROM: Record<string, string[]> = {
  draft: [], // draftへは戻せない
  created_in_mf: ["draft"],
  sent: ["created_in_mf", "draft"], // MF外で送付した場合もsentにできる
  paid: ["sent", "created_in_mf"],
  void: ["draft", "created_in_mf", "sent"],
};

/** 状態遷移（送付済み・入金済みマーク等） body: { id, status } */
export async function PATCH(request: Request) {
  const b = await request.json().catch(() => ({}));
  if (typeof b.id !== "string" || !(b.status in INVOICE_ALLOWED_FROM)) {
    return NextResponse.json(
      { error: "id / status(created_in_mf|sent|paid|void) が必要です" },
      { status: 400 }
    );
  }
  const [existing] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, b.id));
  if (!existing) {
    return NextResponse.json({ error: "請求書が見つかりません" }, { status: 404 });
  }
  if (
    existing.status !== b.status &&
    !INVOICE_ALLOWED_FROM[b.status].includes(existing.status)
  ) {
    return NextResponse.json(
      { error: `不正な遷移: ${existing.status} → ${b.status}` },
      { status: 400 }
    );
  }
  const [updated] = await db
    .update(invoices)
    .set({ status: b.status, updatedAt: new Date() })
    .where(eq(invoices.id, b.id))
    .returning();
  return NextResponse.json({ invoice: updated });
}
