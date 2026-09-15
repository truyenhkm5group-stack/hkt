"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { runShadowBenchmarkAction } from "@/lib/actions/fanpage-sales";
import type { BenchmarkResult } from "@/lib/queries/shadow-benchmark";
import { SOURCE_TYPE_LABEL, CLASSIFICATION_SOURCE_LABEL, type ClassificationSource, type SourceType } from "@/lib/constants/fanpage-sales";

/**
 * Bấm để chạy lại phép phân loại + nhận diện trên chính các hội thoại đã nạp.
 * CHỈ ĐỌC — không gọi mô hình, không gửi tin, không tạo đơn. Bấm lại sau mỗi lần đổi cấu hình.
 */
export function BenchmarkButton({ pancakePageId }: { pancakePageId: string }) {
  const [kq, setKq] = useState<BenchmarkResult | null>(null);
  const [msg, setMsg] = useState("");
  const [pending, start] = useTransition();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              setMsg("");
              const r = await runShadowBenchmarkAction({ pancakePageId });
              if ("error" in r) { setMsg(r.error); return; }
              setKq(r.result);
            })
          }
        >
          {pending ? "Đang chạy…" : "Run Shadow Benchmark"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Chỉ đọc — không gọi mô hình, không gửi tin cho khách, không tạo đơn.
        </span>
        {msg ? <span className="text-xs text-destructive">{msg}</span> : null}
      </div>

      {kq ? (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm font-medium">{kq.total} hội thoại có tin khách</p>

          <div className="grid gap-2 sm:grid-cols-4">
            {(Object.keys(kq.byType) as SourceType[]).map((k) => (
              <div key={k} className="rounded-md border p-2">
                <p className="text-xs text-muted-foreground">{SOURCE_TYPE_LABEL[k]}</p>
                <p className="text-lg font-semibold">{kq.byType[k]}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-md border p-2">
              <p className="text-xs text-muted-foreground">WIN nhận ra mẫu</p>
              <p className="text-lg font-semibold">{kq.winResolved}/{kq.winTotal}</p>
            </div>
            <div className="rounded-md border p-2">
              <p className="text-xs text-muted-foreground">TEST gắn được hồ sơ</p>
              <p className="text-lg font-semibold">{kq.testResolved}/{kq.testTotal}</p>
            </div>
            <div className={`rounded-md border p-2 ${kq.testFellBackToWin > 0 ? "border-destructive" : ""}`}>
              <p className="text-xs text-muted-foreground">TEST bị xử như WIN (phải 0)</p>
              <p className={`text-lg font-semibold ${kq.testFellBackToWin > 0 ? "text-destructive" : ""}`}>{kq.testFellBackToWin}</p>
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            <p className="mb-1 font-medium">Căn cứ phân loại</p>
            <ul className="space-y-0.5">
              {(Object.keys(kq.bySource) as ClassificationSource[]).map((k) => (
                <li key={k}>{CLASSIFICATION_SOURCE_LABEL[k]}: {kq.bySource[k]}</li>
              ))}
            </ul>
            {kq.testMissingPrice > 0 ? (
              <p className="mt-2">{kq.testMissingPrice} hội thoại TEST chưa có giá — máy sẽ không báo giá, và không mượn giá của mã WIN.</p>
            ) : null}
            <p className="mt-2">Chạy lúc {new Date(kq.ranAt).toLocaleString("vi-VN")}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
