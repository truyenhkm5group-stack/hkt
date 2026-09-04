import { z } from "zod";

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Chọn ngày");

export const STOCK_RECEIPT_KINDS = ["RECEIPT", "ADJUSTMENT"] as const;
export type StockReceiptKind = (typeof STOCK_RECEIPT_KINDS)[number];

export const STOCK_RECEIPT_KIND_LABEL: Record<StockReceiptKind, string> = {
  RECEIPT: "Nhập hàng",
  ADJUSTMENT: "Điều chỉnh kiểm kê",
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
        quantity: z.number({ error: "Nhập số lượng" }).int("Số lượng phải là số nguyên").min(-1_000_000).max(1_000_000),
        unitCost: z.number({ error: "Nhập giá nhập" }).int("Giá nhập phải là số nguyên").min(0, "Giá nhập không được âm").max(2_000_000_000),
      }),
    )
    .min(1, "Nhập số lượng cho ít nhất một mẫu mã")
    .refine((items) => items.some((i) => i.quantity !== 0), "Số lượng đều bằng 0"),
});
export type StockReceiptInput = z.infer<typeof stockReceiptSchema>;
