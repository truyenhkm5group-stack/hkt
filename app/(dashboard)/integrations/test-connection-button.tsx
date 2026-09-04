"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, PlugZap, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";

type TestResult =
  | { ok: true; detail: { message?: string; shopName?: string; shopId?: string; shopMatched?: boolean; shops?: { id: string; name: string }[]; accountName?: string; phone?: string; userId?: string; tokenExpiresAt?: string | null; inventories?: number } }
  | { ok: false; error: string };

/** Nút “Kiểm tra kết nối” gọi POST /api/integrations/test và hiện kết quả ngay bên dưới */
export function TestConnectionButton({ provider, disabled }: { provider: "pancake" | "viettelpost"; disabled?: boolean }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const run = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/integrations/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });
      const body = (await res.json().catch(() => null)) as TestResult | null;
      if (!body) setResult({ ok: false, error: `Máy chủ trả về HTTP ${res.status}` });
      else setResult(body);
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : "Lỗi mạng" });
    } finally {
      setCheckedAt(new Date());
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" onClick={run} disabled={loading || disabled}>
        {loading ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
        {loading ? "Đang kiểm tra…" : "Kiểm tra kết nối"}
      </Button>
      {result ? (
        <div className={`rounded-lg border px-3 py-2 text-xs ${result.ok ? "border-success/40 bg-success/10" : "border-destructive/40 bg-destructive/10"}`}>
          <div className="flex items-start gap-2">
            {result.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="font-semibold">{result.ok ? result.detail.message ?? "Kết nối thành công" : "Không kết nối được"}</p>
              {!result.ok ? <p className="break-words text-muted-foreground">{result.error}</p> : null}
              {result.ok && result.detail.shops?.length ? (
                <p className="text-muted-foreground">
                  Shop khả dụng: {result.detail.shops.map((s) => `${s.name} (${s.id})`).join(", ")}
                </p>
              ) : null}
              {result.ok && (result.detail.accountName || result.detail.phone) ? (
                <p className="text-muted-foreground">
                  {result.detail.accountName ? `Tài khoản: ${result.detail.accountName}` : null}
                  {result.detail.phone ? ` · ${result.detail.phone}` : null}
                  {result.detail.userId ? ` · ID ${result.detail.userId}` : null}
                </p>
              ) : null}
              {result.ok && "tokenExpiresAt" in result.detail ? <p className="text-muted-foreground">Token hết hạn: {result.detail.tokenExpiresAt ? formatDateTime(result.detail.tokenExpiresAt) : "không rõ (token dài hạn)"}</p> : null}
              {checkedAt ? <p className="text-[10.5px] text-muted-foreground/80">Kiểm tra lúc {formatDateTime(checkedAt)}</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
