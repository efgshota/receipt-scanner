"use client";

import { useState, useRef } from "react";

interface UploadResult {
  transaction: {
    id: string;
    vendor: string;
    amount: number;
    date: string;
    bucket: string;
    confidence: number;
  };
  classification: {
    bucket: string;
    confidence: number;
    reason: string;
    details?: string;
  };
}

export default function UploadPage() {
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(file: File) {
    setUploading(true);
    setError(null);
    setResult(null);

    // Preview
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target?.result as string);
    reader.readAsDataURL(file);

    // Upload
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/receipts/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error("Upload failed");
      }

      const data = await res.json();
      setResult(data);
    } catch {
      setError("アップロードに失敗しました。もう一度お試しください。");
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  }

  const BUCKET_LABELS: Record<string, string> = {
    nagi: "NAGI",
    stadiums: "stadiums",
    family: "家族",
  };

  return (
    <div className="max-w-lg mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-bold">レシート撮影</h1>
        <a href="/dashboard" className="text-sm text-primary hover:underline">
          ダッシュボード
        </a>
      </div>

      {/* Camera / file input */}
      <div
        onClick={() => fileInputRef.current?.click()}
        className="border-2 border-dashed border-border rounded-xl p-12 text-center cursor-pointer hover:border-primary transition-colors"
      >
        {preview ? (
          <img
            src={preview}
            alt="Preview"
            className="max-h-64 mx-auto rounded-lg"
          />
        ) : (
          <div>
            <div className="text-4xl mb-4">📷</div>
            <p className="text-muted">
              タップしてレシートを撮影
              <br />
              または画像を選択
            </p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* Loading */}
      {uploading && (
        <div className="mt-6 text-center">
          <div className="animate-spin inline-block w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
          <p className="mt-2 text-muted">OCR処理中...</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-6 p-4 bg-red-50 text-red-800 rounded-lg">
          {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="mt-6 bg-card border border-border rounded-lg p-6">
          <h2 className="font-bold mb-4">読み取り結果</h2>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-muted">店舗</dt>
              <dd className="font-medium">{result.transaction.vendor}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">金額</dt>
              <dd className="font-mono font-medium">
                ¥{result.transaction.amount.toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">日付</dt>
              <dd>{result.transaction.date}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">分類</dt>
              <dd>
                <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded-full text-sm">
                  {BUCKET_LABELS[result.classification.bucket] ||
                    result.classification.bucket}
                </span>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">確信度</dt>
              <dd>{Math.round(result.classification.confidence * 100)}%</dd>
            </div>
            {result.classification.details && (
              <div>
                <dt className="text-muted text-sm">
                  {result.classification.details}
                </dt>
              </div>
            )}
          </dl>

          <div className="mt-6 flex gap-3">
            <button
              onClick={() => {
                setResult(null);
                setPreview(null);
              }}
              className="flex-1 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover"
            >
              次のレシート
            </button>
            <a
              href="/dashboard"
              className="flex-1 px-4 py-2 border border-border rounded-lg text-center hover:bg-gray-50"
            >
              ダッシュボードへ
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
