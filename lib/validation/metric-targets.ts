import { z } from "zod";
import { isBindableMetric } from "@/lib/constants/metric-catalog";

/**
 * Lược đồ ở tệp riêng vì tệp `"use server"` KHÔNG được xuất hằng số — đã vấp một lần và mọi lượt
 * bấm bị từ chối trong khi tsc vẫn xanh.
 */
export const targetInput = z.object({
  /** Chỉ nhận khoá CÓ TRONG SỔ và ĐO ĐƯỢC. Đặt đích cho một chỉ số chưa có nguồn là đặt đích cho hư không. */
  metricKey: z.string().min(1).refine(isBindableMetric, { message: "Chỉ số không có trong danh mục hoặc chưa đo được" }),
  scope: z.enum(["COMPANY", "DEPARTMENT", "POSITION"]),
  scopeRef: z.string().trim().max(120).nullable().default(null),
  target: z.number().finite(),
  /** Bắt buộc có lý do: một đích không giải thích được thì kỳ sau không ai dám sửa. */
  note: z.string().trim().min(3, "Phải ghi vì sao đặt con số này").max(400),
  effectiveFrom: z.coerce.date(),
});

export const targetDelete = z.object({ id: z.string().min(1) });
