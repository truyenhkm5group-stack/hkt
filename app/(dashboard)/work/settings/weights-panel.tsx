"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setScoreWeights } from "@/lib/actions/workforce";

/**
 * ═══════════ TRỌNG SỐ ĐIỂM TỔNG — KHÔNG CÓ MẶC ĐỊNH ═══════════
 *
 * Bốn ô, tất cả bắt đầu rỗng. Rỗng hết = màn hình hiệu suất KHÔNG có cột điểm tổng, và đó là
 * trạng thái mặc định lâu dài chứ không phải "chưa cấu hình xong".
 *
 * Sáu trục của thẻ điểm nói về sáu thứ khác nhau; gộp chúng lại chỉ có nghĩa khi có người CHỊU
 * TRÁCH NHIỆM chọn tỉ lệ. Ghi sẵn một bộ số ở đây là lén đưa ra quyết định đó thay chủ shop, rồi
 * ba tháng sau không ai nhớ ai chọn.
 */

const AXES = [
  { key: "outcome" as const, label: "Kết quả", hint: "Phần việc đã đóng mà kết quả thuộc trách nhiệm người xử lý" },
  { key: "quality" as const, label: "Chất lượng", hint: "Phần việc đóng rồi KHÔNG phải mở lại" },
  { key: "sla" as const, label: "Đúng hạn", hint: "Chỉ tính việc CÓ đặt hạn" },
  { key: "okr" as const, label: "OKR", hint: "Tiến độ Key Result cá nhân, chỉ tính KR đo được" },
];

export function WeightsPanel({ weights }: { weights: Partial<Record<"outcome" | "quality" | "sla" | "okr", number>> }) {
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(AXES.map((a) => [a.key, weights[a.key] === undefined ? "" : String(weights[a.key])])));
  const [pending, start] = useTransition();

  const tong = AXES.reduce((s, a) => s + (Number(vals[a.key]) || 0), 0);
  const dirty = AXES.some((a) => (vals[a.key] ?? "") !== (weights[a.key] === undefined ? "" : String(weights[a.key])));

  const luu = (next: Record<string, string>) =>
    start(async () => {
      const payload: Record<string, number> = {};
      for (const a of AXES) {
        const n = Number(next[a.key]);
        if (Number.isFinite(n) && n > 0) payload[a.key] = n;
      }
      const r = await setScoreWeights(payload);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(Object.keys(payload).length ? "Đã lưu trọng số — màn hình Hiệu suất sẽ hiện cột điểm tổng" : "Đã bỏ trọng số — không còn cột điểm tổng");
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        {AXES.map((a) => (
          <div key={a.key} className="grid gap-1">
            <Label htmlFor={`w-${a.key}`} className="text-xs" title={a.hint}>
              {a.label}
            </Label>
            <Input
              id={`w-${a.key}`}
              value={vals[a.key] ?? ""}
              onChange={(e) => setVals((v) => ({ ...v, [a.key]: e.target.value }))}
              inputMode="numeric"
              placeholder="không dùng"
              className="h-8 w-[110px] text-xs tabular-nums"
            />
          </div>
        ))}
        <Button size="sm" disabled={pending || !dirty} onClick={() => luu(vals)}>
          Lưu
        </Button>
        {Object.keys(weights).length ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-xs"
            disabled={pending}
            onClick={() => {
              const trong = Object.fromEntries(AXES.map((a) => [a.key, ""]));
              setVals(trong);
              luu(trong);
            }}
          >
            Bỏ điểm tổng
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {tong > 0
          ? `Tổng trọng số ${tong}. Không cần cộng thành 100 — điểm được chia theo phần trọng số THẬT SỰ ĐO ĐƯỢC của từng người, và độ phủ hiện ngay cạnh điểm.`
          : "Chưa khai trọng số nào ⇒ màn hình Hiệu suất không có cột điểm tổng. Sáu trục vẫn đọc được riêng từng cột — đó là cách đọc an toàn hơn."}
      </p>
    </div>
  );
}
