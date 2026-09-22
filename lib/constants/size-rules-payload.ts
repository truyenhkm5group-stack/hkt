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

/** Các chiều số đo một bảng có thể ràng buộc. */
const DIMS = ["heightCm", "weightKg", "bustCm", "waistCm", "hipCm"] as const;
type Dim = (typeof DIMS)[number];
type Row = { size: string } & Partial<Record<Dim, [number, number]>>;

const DIM_LABEL: Record<Dim, string> = {
  heightCm: "chiều cao",
  weightKg: "cân nặng",
  bustCm: "vòng ngực",
  waistCm: "vòng eo",
  hipCm: "vòng mông",
};

function giao(a?: [number, number], b?: [number, number]): [number, number] | null {
  if (!a && !b) return null;
  if (!a || !b) return (a ?? b) ?? null; // chiều không ràng buộc ở một bên = phủ mọi giá trị
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return lo <= hi ? [lo, hi] : null;
}

/**
 * CẢNH BÁO CỦA MỘT BẢNG — MỘT BẢN, DÙNG CHUNG cho script nhập và cho màn hình sửa.
 *
 * Hai bộ kiểm khác nhau cho cùng một bảng là cách chắc chắn để màn hình nói "sạch" trong khi
 * script nói "có vấn đề", và người dùng tin cái nào thuận tay hơn. Đây đã là lỗi thật một lần
 * trong chính tính năng này (lược đồ nhập lệch khỏi kiểu dữ liệu), nên phép kiểm đi cùng lược đồ.
 *
 * CHỒNG KHOẢNG KHÔNG CÒN LÀ LỖI kể từ khi có luật nâng size ở ranh giới — nó chỉ là điều người
 * sửa bảng nên biết: những khách rơi vào đó sẽ được lấy size lớn hơn, chứ không phải bị bỏ rơi.
 * HÀM THUẦN.
 */
export function sizeRuleWarnings(rule: { version: string; rows: Row[] }): string[] {
  const out: string[] = [];
  for (let i = 0; i < rule.rows.length; i += 1) {
    for (let j = i + 1; j < rule.rows.length; j += 1) {
      const a = rule.rows[i];
      const b = rule.rows[j];
      if (a.size === b.size) continue; // cùng size thì chồng nhau vô hại
      const parts: string[] = [];
      let chongMoiChieu = true;
      for (const k of DIMS) {
        if (!a[k] && !b[k]) continue;
        const g = giao(a[k], b[k]);
        if (!g) {
          chongMoiChieu = false;
          break;
        }
        parts.push(`${DIM_LABEL[k]} ${g[0]}–${g[1]}`);
      }
      if (chongMoiChieu && parts.length) {
        out.push(`size ${a.size} và ${b.size} chồng nhau tại ${parts.join(" · ")} — khách rơi vào đó sẽ được lấy size lớn hơn`);
      }
    }
  }
  // Khoảng lộn đầu đuôi lọt qua lược đồ chỉ khi ai đó dựng dòng bằng tay; kiểm lại cho chắc.
  for (const r of rule.rows) {
    for (const k of DIMS) {
      const v = r[k];
      if (v && v[0] > v[1]) out.push(`size ${r.size}: ${DIM_LABEL[k]} viết ngược (${v[0]}–${v[1]})`);
    }
  }
  return out;
}
