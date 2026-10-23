import { z } from "zod";
import { FABRIC_UNITS } from "@/lib/constants/pending-matrix";

/**
 * Lược đồ ở tệp riêng vì tệp `"use server"` KHÔNG được xuất hằng số.
 *
 * Ô trống là `null` = CHƯA KHAI, không phải 0. Lượng vải phải dương (0 mét / cái là gõ nhầm, không phải
 * định mức); hao hụt 0–100%. CỐ Ý không có trường tên người ghi: tên do MÁY CHỦ đọc (AGENTS 34).
 */
const qty = z.number().positive("Định mức vải phải lớn hơn 0").max(1000, "Định mức vải / cái quá lớn — kiểm lại đơn vị").nullable();

export const fabricNormValue = z.object({
  common: qty.default(null),
  bySize: z.record(z.string().trim().min(1).max(40), qty).default({}),
  wastePct: z.number().min(0, "Hao hụt không âm").max(100, "Hao hụt tối đa 100%").nullable().default(null),
  unit: z.enum(FABRIC_UNITS).default("m"),
});

export const fabricNormInput = fabricNormValue.extend({ productId: z.string().min(1) });

/** Một lượt nhập từ trình duyệt — trần 2.000 sản phẩm để một lượt gửi lạ không làm nghẽn máy chủ. */
export const fabricNormImport = z.object({ entries: z.array(z.object({ productId: z.string().min(1), norm: z.unknown() })).max(2000) });
