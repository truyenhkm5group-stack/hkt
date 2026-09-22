"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { assignSizeChart } from "@/lib/actions/size-rules";
import type { ChartOption } from "@/lib/queries/size-rules";

/**
 * Ô chọn bảng số đo cho MỘT mã hàng.
 *
 * Gửi đi ngay khi đổi, không có nút Lưu: một ô chọn kèm nút Lưu riêng cho mỗi dòng thì sáu dòng là
 * sáu nút, và người dùng đổi xong rời trang mà quên bấm — lựa chọn biến mất không dấu vết.
 *
 * Trong lúc gửi, ô hiển thị giá trị MỚI chứ không quay về giá trị cũ. Nhảy về cũ rồi mới nhảy sang
 * mới khi máy chủ trả lời là kiểu nhấp nháy khiến người dùng tưởng cú bấm không ăn và bấm lại.
 */
export function AssignForm({
  productCode,
  current,
  charts,
}: {
  productCode: string;
  current: string | null;
  charts: ChartOption[];
}) {
  const [value, setValue] = useState(current ?? "");
  const [pending, startTransition] = useTransition();

  return (
    <select
      className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm disabled:opacity-60"
      value={value}
      disabled={pending}
      aria-label={`Bảng số đo cho mã ${productCode}`}
      onChange={(e) => {
        const next = e.target.value;
        const truoc = value;
        setValue(next);
        startTransition(async () => {
          const res = await assignSizeChart({ productCode, chartVersion: next });
          if ("error" in res) {
            // Máy chủ từ chối ⇒ trả ô về đúng thứ CSDL đang giữ. Để nguyên giá trị mới sẽ làm màn
            // hình nói một đằng còn dữ liệu một nẻo, và người dùng tưởng đã gán xong.
            setValue(truoc);
            toast.error(res.error);
            return;
          }
          toast.success(`${productCode} → ${res.chartLabel}`);
        });
      }}
    >
      <option value="">— chưa gán (máy chuyển người khi khách hỏi size) —</option>
      {charts.map((c) => (
        <option key={c.version} value={c.version}>
          {c.label} ({c.sizes.join("/")})
        </option>
      ))}
    </select>
  );
}
