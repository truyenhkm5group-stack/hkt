"use client";

import { useState, useTransition } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { secretsSelfTestAction } from "@/lib/actions/platform-secrets";
import type { SecretsSelfTestReport } from "@/lib/connectors/types";
import { cn } from "@/lib/utils";

/**
 * Nút «Tự kiểm khoá bí mật» (cổng mở bán A). Mọi phép thử chạy ở máy chủ, trong bộ nhớ, trên tổ chức GIẢ — kết quả chỉ
 * có tên phép thử + đạt / hỏng và mã khoá rút gọn; không một ký tự nào của khoá hay chuỗi thử.
 */
export function SecretsSelfTestButton() {
  const [result, setResult] = useState<(SecretsSelfTestReport & { audited: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-1.5" data-secrets-self-test>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await secretsSelfTestAction();
            if ("error" in r) {
              setResult(null);
              setError(r.error);
            } else setResult(r);
          })
        }
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
        Tự kiểm khoá bí mật
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {result ? (
        <div role="status" className={cn("rounded-lg border px-3 py-2 text-xs", result.ok ? "border-emerald-400/50 bg-emerald-50 dark:bg-emerald-950/40" : "border-destructive/40 bg-destructive/5")}>
          <p className="font-semibold">
            {result.ok ? "Tự kiểm ĐẠT" : "Tự kiểm HỎNG"} · nguồn <span className="font-mono">{result.keySource}</span>
            {result.keyIdShort ? (
              <>
                {" "}
                · mã khoá <span className="font-mono">{result.keyIdShort}</span>
              </>
            ) : null}{" "}
            · khoá cũ (PREVIOUS): {result.previous === "ready" ? "có, dùng được" : result.previous === "invalid" ? "đặt nhưng KHÔNG dùng được" : "không đặt"}
          </p>
          {result.reason ? <p className="mt-0.5">{result.reason}</p> : null}
          {result.checks.length ? (
            <ul className="mt-1 space-y-0.5">
              {result.checks.map((c) => (
                <li key={c.name} className={c.ok ? "text-emerald-800 dark:text-emerald-300" : "font-medium text-destructive"}>
                  {c.ok ? "✓" : "✗"} {c.name}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-muted-foreground">{result.audited ? "Đã ghi nhật ký nền tảng (SECRETS_SELF_TEST)." : "KHÔNG ghi được nhật ký nền tảng — kết quả trên vẫn đúng, nhưng lượt kiểm này không có vết."}</p>
        </div>
      ) : null}
    </div>
  );
}
