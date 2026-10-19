/**
 * ═══ KIỂM ĐẦU VÀO PHÂN CÔNG MKTer ↔ MÃ VÀ ĐIỀU KHOẢN THƯỞNG THEO MÃ — HÀM THUẦN ═══
 *
 * Tách khỏi `lib/actions/payroll-code.ts` (tệp "use server" chỉ được xuất hàm async) để kiểm thử gọi
 * thẳng được. Đặc tả: `docs/payroll-code-ledger.md`.
 *
 * ─── Ô TRỐNG KHÔNG PHẢI SỐ 0 ───
 *
 * `z.coerce.number()` biến `""` thành `0` và THÀNH CÔNG — một ô "trần thưởng (bỏ trống = không)" để
 * trống từng được lưu thành trần 0 ₫, và mọi khoản thưởng theo mã lặng lẽ về 0 mà không ai bị báo.
 * Nên mọi ô số đi qua `blank()` trước: trống ⇒ `undefined` ⇒ ô bắt buộc thì BÁO LỖI, ô tuỳ chọn thì
 * "không khai" (AGENTS.md mục 42).
 */
import { createHash } from "node:crypto";
import { z } from "zod";

const blank = (v: unknown) => (v === "" || v === null || (typeof v === "string" && v.trim() === "") ? undefined : v);
const ngay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày phải có dạng YYYY-MM-DD");
const ngayTuyChon = z.preprocess(blank, ngay.optional());
const phanTram = (thieu: string) => z.preprocess(blank, z.coerce.number({ error: thieu }).finite({ error: thieu }).min(0, "Tỷ lệ không được âm").max(100, "Tỷ lệ tối đa 100%"));
const phanTramTuyChon = z.preprocess(blank, z.coerce.number().finite().min(0, "Tỷ lệ không được âm").max(100, "Tỷ lệ tối đa 100%").optional());

export const codeAssignmentSchema = z
  .object({
    productId: z.string().min(1, "Chọn mã sản phẩm"),
    employeeId: z.string().min(1, "Chọn MKTer"),
    role: z.enum(["OWNER", "SUPPORT"]),
    ownerRatePercent: phanTramTuyChon,
    weightMethod: z.preprocess(blank, z.enum(["MANUAL", "AD_SPEND", "ATTRIBUTED_REVENUE"]).optional()),
    weightPercent: phanTramTuyChon,
    effectiveFrom: ngay,
    effectiveTo: ngayTuyChon,
    policyRef: z.string().trim().min(1, "Ghi số hiệu quy chế / hợp đồng mà phân công này áp theo"),
    note: z.string().trim().max(500).default(""),
  })
  .superRefine((d, ctx) => {
    if (d.role === "OWNER" && d.ownerRatePercent === undefined) ctx.addIssue({ code: "custom", message: "OWNER phải có X% (tỷ lệ thưởng trên lợi nhuận đủ điều kiện của mã)" });
    if (d.role === "SUPPORT" && !d.weightMethod) ctx.addIssue({ code: "custom", message: "SUPPORT phải chọn cách tính trọng số" });
    if (d.role === "SUPPORT" && d.weightMethod === "MANUAL" && d.weightPercent === undefined) ctx.addIssue({ code: "custom", message: "Trọng số tay phải có % đã duyệt" });
    if (d.effectiveTo && d.effectiveTo < d.effectiveFrom) ctx.addIssue({ code: "custom", message: "Ngày kết thúc phải sau ngày bắt đầu" });
  });

export const codeTermsSchema = z
  .object({
    productId: z.preprocess(blank, z.string().optional()),
    supportPoolPercent: phanTram("Ghi Y% (quỹ thưởng SUPPORT) — bỏ trống không có nghĩa là 0%"),
    /** Trống = KHÔNG có trần riêng (vẫn chịu quỹ công ty). Không bao giờ là trần 0 ₫. */
    maxBonusAmount: z.preprocess(blank, z.coerce.number().int("Trần thưởng là số nguyên VND").min(0).optional()),
    effectiveFrom: ngay,
    effectiveTo: ngayTuyChon,
    policyRef: z.string().trim().min(1, "Ghi số hiệu quy chế / hợp đồng mà điều khoản này áp theo"),
    note: z.string().trim().max(500).default(""),
  })
  .superRefine((d, ctx) => {
    if (d.effectiveTo && d.effectiveTo < d.effectiveFrom) ctx.addIssue({ code: "custom", message: "Ngày kết thúc phải sau ngày bắt đầu" });
  });

export const codeRowKindSchema = z.enum(["ASSIGNMENT", "TERMS"]);
export const codeEndSchema = z.object({ kind: codeRowKindSchema, id: z.string().min(1), effectiveTo: ngay });
export const codeRevokeSchema = z.object({ kind: codeRowKindSchema, id: z.string().min(1), reason: z.string().trim().min(1, "Ghi lý do huỷ").max(500) });

/**
 * KHOÁ DÒNG CỐ ĐỊNH THEO NỘI DUNG. Duyệt người thứ hai so dấu vân tay gồm `entityId`; một UUID mới
 * mỗi lần bấm làm lời duyệt KHÔNG BAO GIỜ khớp lần gửi lại, và mỗi cú bấm đẻ thêm một yêu cầu.
 * Cùng nội dung ⇒ cùng khoá ⇒ lần gửi lại sau khi được duyệt tiêu thụ đúng lời duyệt ấy, và ghi
 * hai lần cùng một dòng là lỗi khoá chính thay vì hai dòng giống nhau.
 */
export function codeRowId(kind: "ASSIGNMENT" | "TERMS", values: Record<string, unknown>): string {
  const ordered = Object.keys(values)
    .sort()
    .map((k) => [k, values[k] instanceof Date ? (values[k] as Date).toISOString() : (values[k] ?? null)]);
  const h = createHash("sha256").update(JSON.stringify([kind, ordered])).digest("hex").slice(0, 24);
  return `${kind === "ASSIGNMENT" ? "pma" : "pbt"}-${h}`;
}

/**
 * BÀN GIAO OWNER — quyết định THUẦN. Một mã tối đa một OWNER một lúc.
 *  · OWNER mới KHÔNG có ngày kết thúc: đóng các OWNER bắt đầu SỚM HƠN ở ngày liền trước (bàn giao hẳn).
 *  · OWNER mới CÓ ngày kết thúc mà chồng lên OWNER khác: TỪ CHỐI. Đóng người cũ ở đây là cắt luôn
 *    phần sau ngày kết thúc của người mới — quyền của người cũ mất mà không ai quyết.
 *  · OWNER cũ bắt đầu cùng ngày hoặc muộn hơn: TỪ CHỐI (không cách đọc nào đúng).
 */
export function planOwnerHandover(existing: readonly { id: string; from: Date; to: Date | null }[], from: Date, to: Date | null): { close: { id: string; before: Date | null; after: Date }[] } | { error: string } {
  if (!existing.length) return { close: [] };
  if (existing.some((c) => c.from.getTime() >= from.getTime())) return { error: "Mã này đã có OWNER bắt đầu cùng ngày hoặc muộn hơn — mỗi mã tối đa một OWNER một lúc. Kết thúc / huỷ dòng ấy trước." };
  if (to !== null) return { error: "OWNER mới có ngày kết thúc nhưng chồng lên OWNER đang có — ERP không cắt quyền của người cũ sau ngày ấy. Kết thúc OWNER hiện tại trước, hoặc khai OWNER mới không có ngày kết thúc." };
  const after = new Date(from.getTime() - 1);
  return { close: existing.map((c) => ({ id: c.id, before: c.to, after })) };
}
