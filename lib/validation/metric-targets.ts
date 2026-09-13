import { z } from "zod";
import { PERIOD_KINDS } from "@/lib/constants/metric-targets";
import { metricOf, TARGET_SCOPES } from "@/lib/constants/metric-registry";

/**
 * Lược đồ ở tệp riêng vì tệp `"use server"` KHÔNG được xuất hằng số — đã vấp một lần và mọi lượt
 * bấm bị từ chối trong khi tsc vẫn xanh.
 *
 * Khoá nhận được là hợp của HAI sổ chỉ số (`metric-registry.ts`), không chỉ sổ hiệu suất. Nhờ vậy
 * một KR nối vào "tỷ lệ hoàn" và một ô thẻ điểm nói về "tỷ lệ hoàn" đọc CÙNG một đích, thay vì hai
 * con số không ai buộc phải bằng nhau.
 */
export const targetInput = z
  .object({
    /** Chỉ nhận khoá CÓ TRONG SỔ và ĐO ĐƯỢC. Đặt đích cho một chỉ số chưa có nguồn là đặt đích cho hư không. */
    metricKey: z
      .string()
      .min(1)
      .refine((k) => metricOf(k)?.targetable === true, { message: "Chỉ số không có trong sổ, hoặc chưa đo được nên không đặt đích được" }),
    scope: z.enum(TARGET_SCOPES),
    scopeRef: z.string().trim().max(120).nullable().default(null),
    target: z.number().finite(),
    /** Cận trên của đích dạng DẢI. Bỏ trống = đích một chiều. */
    targetMax: z.number().finite().nullable().default(null),
    warningAt: z.number().finite().nullable().default(null),
    criticalAt: z.number().finite().nullable().default(null),
    periodKind: z.enum(PERIOD_KINDS).default("ANY"),
    /** Bắt buộc có lý do: một đích không giải thích được thì kỳ sau không ai dám sửa. */
    note: z.string().trim().min(3, "Phải ghi vì sao đặt con số này").max(400),
    effectiveFrom: z.coerce.date(),
    effectiveTo: z.coerce.date().nullable().default(null),
    ownerDepartment: z.string().trim().max(60).nullable().default(null),
  })
  .refine((d) => d.targetMax === null || d.targetMax > d.target, { message: "Cận trên của dải phải lớn hơn cận dưới", path: ["targetMax"] })
  .refine((d) => d.effectiveTo === null || d.effectiveTo.getTime() > d.effectiveFrom.getTime(), { message: "Hạn kết thúc phải sau mốc hiệu lực", path: ["effectiveTo"] });

export const targetDelete = z.object({ id: z.string().min(1) });
