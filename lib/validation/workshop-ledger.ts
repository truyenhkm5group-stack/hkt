import { z } from "zod";
import { FABRIC_SOURCES, PAYMENT_KINDS, PAYMENT_METHODS } from "@/lib/constants/workshop-ledger";

/**
 * Lược đồ đầu vào của Sổ đặt xưởng — ở tệp riêng vì tệp `"use server"` KHÔNG được xuất hằng số.
 *
 * Không có ô nào cho TÊN người ghi (mục 34: máy chủ đọc từ `users`), và không có ô nào cho TỔNG TIỀN
 * CÔNG: tiền công luôn là SL chốt × đơn giá + thưởng/phạt, tính ở `laborCost()`. Cho gõ tổng tay là
 * mở đường cho hai con số cùng tên nói hai điều khác nhau.
 *
 * Ô số để TRỐNG ⇒ `null` (CHƯA BIẾT), không phải 0 (mục 42).
 */

const dateKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày không hợp lệ");
const optionalDateKey = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(dateKey.nullable())
  .nullable()
  .default(null);
/** Ô số tự do: "" / null ⇒ null; còn lại phải là số nguyên. */
const optionalInt = (min: number) => z.preprocess((v) => (v === "" || v == null ? null : typeof v === "string" ? Number(v.replace(/[^\d-]/g, "")) : v), z.number().int().min(min).nullable());
const optionalDecimal = z.preprocess((v) => (v === "" || v == null ? null : typeof v === "string" ? Number(v.replace(",", ".")) : v), z.number().min(0).nullable());

export const batchInput = z.object({
  productCode: z.string().trim().min(1, "Nhập mã hàng").max(50),
  productName: z.string().trim().max(200).default(""),
  batchNo: z.coerce.number().int().min(1, "Số lô phải từ 1").max(999),
  supplier: z.string().trim().max(120).default(""),
  productionOrderId: z.string().trim().max(64).nullable().default(null),
  orderedAt: dateKey,
  orderedQty: z.coerce.number().int().min(0).max(1_000_000),
  agreedQty: optionalInt(0),
  dueDate: optionalDateKey,
  laborUnitPrice: optionalInt(0),
  adjustment: z.coerce.number().int().min(-1_000_000_000).max(1_000_000_000).default(0),
  adjustmentNote: z.string().trim().max(300).default(""),
  fabricSource: z.enum(FABRIC_SOURCES).default("SHOP"),
  note: z.string().trim().max(1000).default(""),
});
export type BatchInput = z.input<typeof batchInput>;

export const deliveryInput = z.object({
  batchId: z.string().min(1),
  deliveredAt: dateKey,
  quantity: z.coerce
    .number()
    .int()
    .refine((n) => n !== 0, "Số lượng phải khác 0 (âm = trả lại xưởng hàng lỗi)")
    .refine((n) => Math.abs(n) <= 1_000_000, "Số lượng quá lớn"),
  note: z.string().trim().max(300).default(""),
});

export const fabricInput = z.object({
  productCode: z.string().trim().max(50).default(""),
  batchId: z.string().trim().max(64).nullable().default(null),
  supplier: z.string().trim().max(120).default(""),
  description: z.string().trim().max(200).default(""),
  orderedAt: dateKey,
  receivedAt: optionalDateKey,
  quantity: optionalDecimal,
  unit: z.string().trim().max(20).default(""),
  unitPrice: optionalInt(0),
  amount: z.coerce.number().int().min(0, "Thành tiền không được âm").max(10_000_000_000),
  note: z.string().trim().max(1000).default(""),
});
export type FabricInput = z.input<typeof fabricInput>;

export const paymentInput = z
  .object({
    batchId: z.string().trim().min(1).nullable().default(null),
    fabricOrderId: z.string().trim().min(1).nullable().default(null),
    kind: z.enum(PAYMENT_KINDS).default("PAYMENT"),
    amount: z.coerce.number().int().min(1, "Số tiền phải lớn hơn 0").max(10_000_000_000),
    paidAt: dateKey,
    method: z.enum(PAYMENT_METHODS).default("BANK"),
    reference: z.string().trim().max(120).default(""),
    note: z.string().trim().max(500).default(""),
  })
  .refine((p) => (p.batchId == null) !== (p.fabricOrderId == null), "Đợt thanh toán phải gắn đúng một lô hoặc một đợt vải");
