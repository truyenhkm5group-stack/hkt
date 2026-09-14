import { z } from "zod";
import { NOTE_CATEGORIES, NOTE_MAX_LENGTH } from "@/lib/constants/product-notes";

/**
 * Lược đồ ở tệp riêng vì tệp `"use server"` KHÔNG được xuất hằng số.
 *
 * CỐ Ý không có trường nào cho tên người viết. Tên do MÁY CHỦ đọc từ `users`; nhận nó từ client
 * thì dòng dữ liệu nói một đằng còn quy kết một nẻo (AGENTS.md mục 34).
 */
export const productNoteInput = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1).nullable().default(null),
  category: z.enum(NOTE_CATEGORIES).default("OTHER"),
  body: z.string().trim().min(3, "Ghi chú quá ngắn để ai đó đọc lại hiểu được").max(NOTE_MAX_LENGTH),
});

export const productNoteDelete = z.object({ id: z.string().min(1) });
