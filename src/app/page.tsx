import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8">
      <h1 className="text-4xl font-bold mb-2">Receipt Scanner</h1>
      <p className="text-muted mb-12">経費精算自動化システム</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 w-full max-w-md">
        <Link
          href="/upload"
          className="flex flex-col items-center p-8 bg-card border border-border rounded-xl hover:border-primary transition-colors"
        >
          <span className="text-4xl mb-3">📷</span>
          <span className="font-semibold">レシート撮影</span>
          <span className="text-sm text-muted mt-1">
            紙のレシートをスキャン
          </span>
        </Link>

        <Link
          href="/dashboard"
          className="flex flex-col items-center p-8 bg-card border border-border rounded-xl hover:border-primary transition-colors"
        >
          <span className="text-4xl mb-3">📊</span>
          <span className="font-semibold">ダッシュボード</span>
          <span className="text-sm text-muted mt-1">
            経費の確認・承認
          </span>
        </Link>
      </div>
    </div>
  );
}
