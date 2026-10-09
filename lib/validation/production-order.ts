import { z } from "zod";

/** Đầu vào của `saveProductionOrder` (`lib/actions/production.ts`) — tách ra để bài kiểm đọc được lược đồ (tệp "use server" chỉ xuất được hàm async). */
export const productionOrderInputSchema = z.object({
  productId: z.string().min(1),
  productCode: z.string().trim().max(50).default(""),
  productName: z.string().trim().max(200),
  colors: z.array(z.string().trim().min(1).max(40)).min(1, "Cần ít nhất một màu").max(20),
  sizes: z.array(z.string().trim().min(1).max(20)).min(1, "Cần ít nhất một size").max(20),
  cells: z.record(z.string(), z.number().int().min(0).max(100000)),
  images: z.array(z.object({ color: z.string().max(40), url: z.string().trim().url().max(600) })).max(20).default([]),
  /*
    Giá gia công / nhập mỗi sản phẩm. Bỏ trống = CHƯA BIẾT ⇒ `null`, KHÔNG BAO GIỜ 0 (AGENTS.md mục 42):
    bản cũ `.default(0)` lưu 0 rồi đưa `số món × 0 = 0` vào cổng duyệt đặt hàng lớn — lệnh chưa ai biết
    tốn bao nhiêu lọt qua duyệt hai bước dễ nhất. Gõ 0 cũng bị từ chối: cột này mọi nơi đọc coi 0 là
    "chưa nhập", nên lưu 0 là lưu một chỗ trống trá hình.
  */
  unitCost: z.number().int("Giá gia công là số nguyên VND").positive("Giá gia công phải lớn hơn 0 — chưa có giá thì để trống").nullable().default(null),
  supplier: z.string().trim().max(120).default(""),
  note: z.string().trim().max(1000).default(""),
  dueDate: z.string().trim().optional().nullable(),
  /*
    Company OS · Agent C. `designVersionId`: `undefined` = nơi gọi không nói gì (giữ bản duyệt đang có),
    `null` = bỏ trỏ. `fromSuggestion`: người vừa "điền theo đề xuất" (hoặc mở bảng mới — ô khởi tạo LÀ
    đề xuất) ⇒ máy chủ TÍNH LẠI gợi ý theo đúng căn cứ kế hoạch rồi lưu ảnh chụp; không nhận gợi ý từ
    trình duyệt. `overrideReason`: bắt buộc khi số chốt khác gợi ý dù một ô (không ngưỡng — luật 38).
  */
  designVersionId: z.string().trim().min(1).nullable().optional(),
  fromSuggestion: z.boolean().default(false),
  suggestionBasis: z.object({ coverDays: z.number().int().min(0).max(3650).optional(), countIncoming: z.boolean().optional() }).optional(),
  overrideReason: z.string().trim().max(1000).default(""),
});
