import { NextResponse } from "next/server";
import { getMfConfigStatus } from "@/lib/integrations/mf-expense-api";
import { getMfInvoiceStatus } from "@/lib/integrations/mf-invoice-api";
import { getStoredToken } from "@/lib/integrations/token-store";
import { listGmailAccounts } from "@/lib/ingest/gmail-client";

/** 全連携の接続状態サマリ（設定画面用） */
export async function GET() {
  const [nagi, stadiums, invoice] = await Promise.all([
    getMfConfigStatus("nagi"),
    getMfConfigStatus("stadiums"),
    getMfInvoiceStatus(),
  ]);

  const [nagiToken, stadiumsToken] = await Promise.all([
    getStoredToken("mf_expense:nagi"),
    getStoredToken("mf_expense:stadiums"),
  ]);

  const gmailAccounts = listGmailAccounts().map((a) => ({
    name: a.name,
    email: a.email,
  }));

  return NextResponse.json({
    mfExpense: {
      nagi: {
        ...nagi,
        offices: (nagiToken?.meta?.offices as unknown[]) ?? [],
        officeId: (nagiToken?.meta?.officeId as string | null) ?? null,
        defaultExItemId:
          (nagiToken?.meta?.defaultExItemId as string | null) ?? null,
      },
      stadiums: {
        ...stadiums,
        offices: (stadiumsToken?.meta?.offices as unknown[]) ?? [],
        officeId: (stadiumsToken?.meta?.officeId as string | null) ?? null,
        defaultExItemId:
          (stadiumsToken?.meta?.defaultExItemId as string | null) ?? null,
      },
    },
    mfInvoice: invoice,
    gmail: {
      accounts: gmailAccounts,
      configured: gmailAccounts.length > 0,
    },
    cronConfigured: Boolean(process.env.CRON_SECRET),
  });
}
