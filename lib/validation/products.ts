import { z } from "zod";
import { SKU_MAX, SKU_PATTERN } from "@/lib/constants/manual-products";

/**
 * Đầu vào tạo / sửa sản phẩm TẠO TAY (lib/records/product-create.ts). Client-safe — form dùng lại để báo lỗi sớm.
 * Tiền: số nguyên VND. `null` = CHƯA KHAI (giá vốn chưa biết), khác hẳn 0 đ — lưu xuống cột tiền `NOT NULL` là 0 vì
 * thang giá vốn đọc 0 như "chưa có" (`nullif`), nhưng lời khai gốc vẫn giữ `null` trong nhật ký.
 */
const money = z.number({ error: "Nhập số tiền" }).int("Tiền là số nguyên (đồng)").min(0, "Tiền không được âm").max(2_000_000_000, "Số tiền quá lớn").nullable().default(null);

const sku = z
  .string()
  .trim()
  .min(1, "Nhập mã SKU")
  .max(SKU_MAX, `Mã SKU tối đa ${SKU_MAX} ký tự`)
  .regex(SKU_PATTERN, "Mã SKU chỉ gồm chữ/số Latin và . _ - / (không dấu cách)");

export const manualVariantSchema = z.object({
  /** Có ⇒ sửa mẫu mã đã có (phải là mẫu mã tạo tay của CHÍNH sản phẩm này); không ⇒ thêm mẫu mã mới. */
  id: z.string().trim().max(100).optional(),
  sku,
  size: z.string().trim().max(50, "Size tối đa 50 ký tự").default(""),
  color: z.string().trim().max(50, "Màu tối đa 50 ký tự").default(""),
  /** `null` ⇒ lấy giá chung của sản phẩm. */
  retailPrice: money,
  /** Giá vốn khai tay của mẫu mã; `null` ⇒ lấy giá vốn chung. */
  cost: money,
  selling: z.boolean().default(true),
});

export const manualProductSchema = z.object({
  name: z.string().trim().min(1, "Nhập tên sản phẩm").max(200, "Tên tối đa 200 ký tự"),
  /** Mã sản phẩm (`products.custom_id`) — duy nhất trong tổ chức. */
  code: sku,
  unit: z.string().trim().min(1, "Nhập đơn vị tính").max(30, "Đơn vị tối đa 30 ký tự"),
  retailPrice: money,
  cost: money,
  variants: z.array(manualVariantSchema).min(1, "Sản phẩm phải có ít nhất một mẫu mã").max(200, "Tối đa 200 mẫu mã mỗi lần"),
});

export type ManualProductInput = z.infer<typeof manualProductSchema>;
export type ManualProductInputRaw = z.input<typeof manualProductSchema>;
export type ManualVariantInput = z.infer<typeof manualVariantSchema>;
