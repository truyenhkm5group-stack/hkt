/**
 * ═══════════ LƯỢC ĐỒ CỦA TỆP BẢNG SỐ ĐO — MỘT BẢN, DÙNG CHUNG ═══════════
 *
 * Script nhập (`scripts/import-size-rules.ts`) kiểm tệp bằng lược đồ này, và bài kiểm dùng ĐÚNG
 * lược đồ này để soi tệp hạt giống đã vào kho. Nhờ vậy "tệp có nạp được không" là một câu trả lời
 * được ở mức mã nguồn, không phải một điều chỉ biết khi đứng trước máy chủ.
 *
 * ─── VÌ SAO TÁCH RA KHỎI SCRIPT ───
 *
 * Nó từng nằm trong chính script, và hai bên đã lệch nhau đúng một lần: `SizeRule` được thêm
 * `label` và `keys` để một bảng gán được cho nhiều mã hàng, còn lược đồ nhập thì không biết hai
 * trường ấy. Hậu quả có hai tầng, và tầng thứ hai mới đáng sợ:
 *
 *   · `.refine()` đòi `key` ⇒ tệp bị TỪ CHỐI thẳng. Cái này ồn ào, dễ thấy.
 *   · Nếu vượt qua được vế trên, zod MẶC ĐỊNH CẮT BỎ khoá lạ ⇒ `keys` biến mất trên đường ghi,
 *     `settings` nhận về những bảng không gán cho mã nào, và máy tiếp tục trả SIZE_DATA_MISSING
 *     y như lúc chưa khai gì. Không lỗi, không cảnh báo, và người khai tin rằng đã xong.
 *
 * Một lược đồ nằm cạnh thứ nó mô tả thì còn lệch được; một lược đồ mà bài kiểm bắt phải nuốt được
 * chính tệp trong kho thì không.
 */
import { z } from "zod";
import { FABRIC_STRETCH, SIZE_SCOPES } from "@/lib/constants/size-engine";

const rangeSchema = z
  .tuple([z.number(), z.number()])
  .refine(([lo, hi]) => lo <= hi, { message: "Khoảng phải là [nhỏ, lớn] — viết ngược là bảng sai" });

export const sizeRowSchema = z.object({
  size: z.string().trim().min(1, "Mỗi dòng phải có tên size"),
  heightCm: rangeSchema.optional(),
  weightKg: rangeSchema.optional(),
  bustCm: rangeSchema.optional(),
  waistCm: rangeSchema.optional(),
  hipCm: rangeSchema.optional(),
});

/** Mọi khoá của một bảng — `key` đơn (lối cũ) và `keys` nhiều gộp làm một rổ. */
export function allKeysOf(rule: { key?: string; keys?: string[] }): string[] {
  return [rule.key ?? "", ...(rule.keys ?? [])].map((k) => k.trim()).filter(Boolean);
}

export const sizeRuleSchema = z
  .object({
    version: z.string().trim().min(1, "Bảng phải có tên phiên bản"),
    /** Tên cho người đọc. Thiếu thì màn hình rơi về `version`, đọc được nhưng xấu. */
    label: z.string().trim().max(60).optional(),
    scope: z.enum(SIZE_SCOPES),
    key: z.string().trim().optional(),
    /** Nhiều mã hàng dùng chung một bảng — sáu mã, hai bảng, không phải sáu bảng. */
    keys: z.array(z.string().trim().min(1)).optional(),
    fabricStretch: z.enum(FABRIC_STRETCH).optional(),
    rows: z.array(sizeRowSchema).min(1, "Bảng phải có ít nhất một dòng size"),
    note: z.string().trim().max(300).optional(),
  })
  .refine((rule) => rule.scope === "GLOBAL" || allKeysOf(rule).length > 0, {
    message: "Phạm vi khác GLOBAL bắt buộc có `key` hoặc `keys` (mã mẫu mã / mã hàng / tên nhóm hàng)",
  })
  .refine((rule) => rule.rows.some((row) => row.heightCm || row.weightKg || row.bustCm || row.waistCm || row.hipCm), {
    message: "Bảng không có một khoảng số đo nào thì không gợi ý được gì — đó không phải bảng số đo",
  })
  .refine((rule) => new Set(allKeysOf(rule).map((k) => k.toLowerCase())).size === allKeysOf(rule).length, {
    message: "Một mã hàng khai hai lần trong cùng bảng — sửa cho sạch, vì nó che dấu một lỗi chép dán",
  });

/**
 * `_doc` được khai TƯỜNG MINH để zod không cắt nó đi.
 *
 * Tệp hạt giống mang phần giải thích ngay trong nó — ai mở ra cũng đọc được vì sao ô "HẾT SIZE"
 * không có dòng, vì sao bảng nữ không khai vòng ngực. Cắt nó lúc ghi thì lời giải thích chỉ còn ở
 * kho mã, còn thứ đang chạy trên máy chủ thì trần trụi.
 */
export const sizePayloadSchema = z.object({
  _doc: z.array(z.string()).optional(),
  version: z.string().trim().min(1),
  rules: z.array(sizeRuleSchema).min(1),
});

export type SizePayload = z.infer<typeof sizePayloadSchema>;
