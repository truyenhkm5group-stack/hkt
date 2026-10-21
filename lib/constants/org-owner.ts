/**
 * ═══ CHỦ SHOP — MỘT DANH TÍNH KHAI TƯỜNG MINH, KHÔNG SUY RA ═══
 *
 * Chủ shop 21/10/2026 (qua Tech Lead, nguyên văn): «Nếu có kế toán thì kế toán làm bảng lương và tôi duyệt,
 * nếu không có kế toán hoặc nếu tôi làm bảng lương thì không cần duyệt nữa.»
 *
 * Để luật ấy chạy, ERP phải biết ĐÚNG ai là chủ shop — và mã nguồn không có câu trả lời nào an toàn:
 *  · `platform_organizations` không có cột chủ; `platform_accounts` chỉ có email nhận hoá đơn.
 *  · Vai trò `ADMIN` CẤP được cho người khác — miễn duyệt theo vai trò là một ADMIN mới tự duyệt lương.
 *  · Chức danh không sinh quyền, không bao giờ (AGENTS.md mục 29).
 *
 * Nên chủ shop là MỘT `users.id` khai ở `settings` khoá `org.owner`, mỗi tổ chức trong CSDL của chính nó. KHÔNG có
 * đường ghi nào trong ứng dụng (`tests/org-owner.test.ts` quét mã nguồn): chỉ ops `set-setting` ghi được, nên một
 * ADMIN trong ứng dụng không tự phong mình làm chủ. Lúc dùng phải khớp CẢ BA — đúng id · tài khoản còn bật · vai
 * trò `ADMIN`; thiếu một thứ ⇒ rơi về luật hai người như cũ (mục 31: mọi nhánh lỗi rơi về phía HẸP HƠN).
 */
import type { ApprovalGroup } from "@/lib/constants/approval";

export const ORG_OWNER_KEY = "org.owner";

/** Câu ghi vào nhật ký mỗi lần luật «chủ shop tự duyệt» được dùng. */
export const OWNER_SELF_APPROVAL_REASON = "Chủ shop tự duyệt theo quy định 21/10/2026 — chủ shop làm bảng lương thì không cần người thứ hai.";

/** Nhóm việc mà chủ shop tự làm thì không cần người thứ hai. Chỉ lương — chủ shop không nói gì về nhóm khác. */
export const OWNER_SELF_APPROVAL_GROUPS: readonly ApprovalGroup[] = ["PAYROLL_EDIT"];

export type OrgOwnerDecl = { userId: string; decidedAt: string | null; note: string };

/** Đọc lời khai. Hỏng / thiếu / sai dạng ⇒ `null` (không có chủ shop nào được miễn). */
export function parseOrgOwner(raw: string | null | undefined): OrgOwnerDecl | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const userId = typeof o.userId === "string" ? o.userId.trim() : "";
  if (!userId) return null;
  return { userId, decidedAt: typeof o.decidedAt === "string" ? o.decidedAt : null, note: typeof o.note === "string" ? o.note : "" };
}

/** Người này có đúng là chủ shop đã khai không — khớp id, tài khoản còn bật, vai trò ADMIN. */
export function isDeclaredOwner(decl: OrgOwnerDecl | null, user: { id: string; active: boolean; role: string } | null | undefined): boolean {
  return Boolean(decl && user && user.id === decl.userId && user.active === true && user.role === "ADMIN");
}
