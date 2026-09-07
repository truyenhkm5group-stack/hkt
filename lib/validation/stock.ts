import { z } from "zod";

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Chọn ngày");

/**
 * Loại phiếu kho. Quy ước dấu số lượng: DƯƠNG = vào kho, ÂM = ra kho.
 * Tồn thực tế = tổng số lượng mọi phiếu − hàng đã xuất qua ĐVVC.
 */
export const STOCK_RECEIPT_KINDS = ["RECEIPT", "RETURN", "ISSUE", "ADJUSTMENT"] as const;
export type StockReceiptKind = (typeof STOCK_RECEIPT_KINDS)[number];

export const STOCK_RECEIPT_KIND_LABEL: Record<StockReceiptKind, string> = {
  RECEIPT: "Nhập hàng mới",
  RETURN: "Tái nhập hàng hoàn",
  ISSUE: "Xuất kho tay (không qua ĐVVC)",
  ADJUSTMENT: "Điều chỉnh kiểm kê",
};

export const STOCK_RECEIPT_KIND_HINT: Record<StockReceiptKind, string> = {
  RECEIPT: "Hàng về từ xưởng / nhà cung cấp. Nhập số lượng dương và giá nhập để cập nhật giá vốn.",
  RETURN: "Kho đếm hàng hoàn thực tế nhận về. Chọn vận đơn hoàn rồi sửa số lượng đúng số đếm được — thiếu bao nhiêu ERP ghi nhận là hàng hụt.",
  ISSUE: "Hàng rời kho không qua Viettel Post (khách tới lấy, ship nội thành, gửi tay). Nhập số lượng dương, ERP tự trừ kho.",
  ADJUSTMENT: "Sửa lệch sau kiểm kê. Số dương = tăng tồn, số âm = giảm tồn.",
};

export const stockReceiptSchema = z.object({
  kind: z.enum(STOCK_RECEIPT_KINDS, { error: "Chọn loại phiếu" }),
  receivedAt: dateKey,
  reference: z.string().trim().max(200, "Tham chiếu tối đa 200 ký tự"),
  supplier: z.string().trim().max(200, "Nhà cung cấp tối đa 200 ký tự"),
  note: z.string().trim().max(1000, "Ghi chú tối đa 1000 ký tự"),
  items: z
    .array(
      z.object({
        variantId: z.string().min(1, "Thiếu mẫu mã"),
        /** Vận đơn hoàn được tái nhập (chỉ phiếu RETURN) — để truy nguyên hàng nào đã thực sự về kho. */
        shipmentId: z.string().trim().optional(),
        quantity: z.number({ error: "Nhập số lượng" }).int("Số lượng phải là số nguyên").min(-1_000_000).max(1_000_000),
        unitCost: z.number({ error: "Nhập giá nhập" }).int("Giá nhập phải là số nguyên").min(0, "Giá nhập không được âm").max(2_000_000_000),
      }),
    )
    .min(1, "Nhập số lượng cho ít nhất một mẫu mã")
    .refine((items) => items.some((i) => i.quantity !== 0), "Số lượng đều bằng 0"),
});
export type StockReceiptInput = z.infer<typeof stockReceiptSchema>;
