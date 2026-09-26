"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { listApprovalSectionItems, type ApprovalSectionItem } from "@/lib/queries/approvals";
import { can, requireUser, type SessionUser } from "@/lib/auth/session";
import { guardWithinScope } from "@/lib/approvals/execution";
import {
  applyLegacyEnforceCore,
  decideApprovalCore,
  readEnforceConfig,
  readLegacyEnforce,
  setEnforceGroupCore,
  type GuardInput,
  type GuardResult,
} from "@/lib/approvals/service";
import {
  APPROVAL_GROUP_LABEL,
  APPROVAL_GROUP_REASON,
  APPROVAL_GROUPS,
  APPROVAL_GROUPS_WIRED,
  isEnforced,
  legacyToV2,
  type ApprovalGroup,
} from "@/lib/constants/approval";

const setEnforceSchema = z.object({ group: z.enum(APPROVAL_GROUPS), enforced: z.boolean() });

/**
 * ═══════ CỔNG PHÊ DUYỆT HAI BƯỚC ═══════
 *
 * Ba điều file này giữ, và cả ba đều là chỗ những cơ chế kiểu này thường hỏng:
 *
 *  1. **GHI NHẬN TRƯỚC, CƯỠNG CHẾ SAU.** Ngay cả khi nhóm chưa bật cưỡng chế, việc rủi ro vẫn được
 *     ghi lại kèm nhãn "chưa cần duyệt". Nếu chỉ ghi khi đã bật thì ngày bật lên, shop không có một
 *     dòng lịch sử nào để biết trước đó những việc này xảy ra bao nhiêu lần.
 *  2. **THIẾU NGƯỜI DUYỆT KHÔNG PHẢI LÀ ĐƯỢC DUYỆT.** Không có ai đủ tư cách gật thì việc DỪNG và
 *     nói rõ vì sao. Một cơ chế tự bỏ qua chính mình khi bất tiện sẽ im lặng đúng lúc bị lợi dụng.
 *  3. **NGƯỜI XIN KHÔNG TỰ DUYỆT** — chặn ở đây, và chặn thêm một lần nữa bằng ràng buộc CSDL.
 */

/**
 * Ai được quyền gật một nhóm việc: quyền `approvals:decide`.
 *
 * Trước Company OS đây là một điều kiện theo VAI (`settings:manage` HOẶC vai ADMIN / MANAGER) viết
 * tay ở tệp này. Nay tập người ấy được tính ở ĐÚNG MỘT chỗ — `lib/auth/access.ts` +
 * `withDerivedApprovalDecide()` trong `lib/auth/permissions.ts` — và giữ NGUYÊN tập cũ: ADMIN,
 * MANAGER, và ai có `settings:manage` luôn có nó. Vai trò tuỳ chỉnh KHÔNG tự cấp được nó
 * (`ROLE_BUILDER_FORBIDDEN`, AGENTS.md mục 31). Cố ý hẹp: duyệt là trách nhiệm, không phải tiện ích.
 */
function coTheDuyet(user: SessionUser): boolean {
  return can(user, "approvals:decide");
}

export type { GuardInput } from "@/lib/approvals/service";

/**
 * Hỏi cổng: việc này làm luôn được, hay phải chờ người thứ hai?
 *
 * Gọi TRƯỚC khi ghi dữ liệu. Trả `PROCEED` thì cứ làm; trả hai mode còn lại thì dừng và trả thông
 * điệp cho người dùng. Người xin làm lại ĐÚNG việc đã được duyệt thì lời duyệt được TIÊU THỤ (một
 * lần) và trả `PROCEED` — xem `lib/approvals/service.ts`.
 *
 * Gọi trong thân một action bọc bằng `withApprovalExecution` (lib/approvals/execution.ts) thì lượt tiêu
 * thụ chỉ là GIỮ CHỖ: action hỏng ⇒ lời duyệt trả lại kèm `execution_error`; xong ⇒ `approval.executed`.
 */
export async function guardSecondApproval(input: GuardInput): Promise<GuardResult> {
  const user = await requireUser();
  const db = await getDb();
  const kq = await guardWithinScope(db, { id: user.id, email: user.email }, input);
  if (kq.mode === "NEEDS_APPROVAL" || kq.consumed) {
    revalidatePath("/alerts");
    revalidatePath("/work");
  }
  return kq;
}

export async function decideApproval(id: string, dong_y: boolean, note?: string): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const db = await getDb();
  const kq = await decideApprovalCore(db, { id: user.id, email: user.email, canDecide: coTheDuyet(user) }, id, dong_y, note);
  if ("ok" in kq) {
    revalidatePath("/alerts");
    revalidatePath("/work");
  }
  return kq;
}

/* ═══════ BẬT / TẮT CƯỠNG CHẾ — CHỈ QUẢN TRỊ VIÊN, VÀ BẬT LÀ QUYẾT ĐỊNH CỦA CHỦ SHOP ═══════
 *
 * Trước bản này không đoạn mã nào GHI khoá `approval.enforce`: cưỡng chế chỉ bật được bằng tay vào
 * CSDL. Công tắc ở đây ghi đúng khoá ấy, theo từng nhóm, và để lại một dòng nhật ký trước/sau.
 * `ADS_BUDGET_MUTATION` CỐ Ý không nối (docs/marketing-ai-department.md) nên không bật được ở đây.
 */
export type ApprovalEnforceState = {
  groups: { group: ApprovalGroup; label: string; reason: string; enforced: boolean; wired: boolean }[];
  /** Dòng CŨ `approval.enforce` nếu có — chưa từng có hiệu lực, chỉ hiện để quản trị viên quyết. */
  legacy: { raw: string; groups: { group: ApprovalGroup; label: string }[]; ignored: string[] } | null;
};

export async function getApprovalEnforceState(): Promise<ApprovalEnforceState | null> {
  const user = await requireUser();
  if (user.role !== "ADMIN") return null;
  const db = await getDb();
  const cfg = await readEnforceConfig(db);
  const legacy = await readLegacyEnforce(db);
  const chuyen = legacy ? legacyToV2(legacy) : null;
  return {
    groups: APPROVAL_GROUPS.map((g) => ({ group: g, label: APPROVAL_GROUP_LABEL[g], reason: APPROVAL_GROUP_REASON[g], enforced: isEnforced(cfg, g), wired: APPROVAL_GROUPS_WIRED.includes(g) })),
    legacy: legacy && chuyen ? { raw: legacy.raw, groups: legacy.groups.map((g) => ({ group: g, label: APPROVAL_GROUP_LABEL[g] })), ignored: chuyen.ignored } : null,
  };
}

export async function setApprovalEnforce(group: string, enforced: boolean): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const parsed = setEnforceSchema.safeParse({ group, enforced });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const kq = await setEnforceGroupCore(await getDb(), { id: user.id, email: user.email, isAdmin: user.role === "ADMIN" }, parsed.data.group, parsed.data.enforced);
  if ("ok" in kq) revalidatePath("/alerts");
  return kq;
}

/** Nút "Áp dụng cấu hình này" cho dòng cưỡng chế CŨ — xem `applyLegacyEnforceCore`. */
export async function applyLegacyApprovalEnforce(): Promise<{ ok: true; applied: string[]; ignored: string[] } | { error: string }> {
  const user = await requireUser();
  const kq = await applyLegacyEnforceCore(await getDb(), { id: user.id, email: user.email, isAdmin: user.role === "ADMIN" });
  if ("ok" in kq) revalidatePath("/alerts");
  return kq;
}

/**
 * Mục "việc chờ duyệt" trên trang Cần xử lý: yêu cầu ĐANG CHỜ + lời duyệt ĐÃ TRẢ LẠI sau một lần thực thi
 * không hoàn tất (kèm câu nhắc `execution_error` — Company OS · Agent N). Dữ liệu dựng ở
 * `listApprovalSectionItems` (lib/queries/approvals.ts); đây chỉ đọc phiên đăng nhập.
 */
export type PendingApproval = ApprovalSectionItem;

export async function listPendingApprovals(limit = 50): Promise<PendingApproval[]> {
  const user = await requireUser();
  return listApprovalSectionItems({ id: user.id, canDecide: coTheDuyet(user) }, new Date(), limit);
}
