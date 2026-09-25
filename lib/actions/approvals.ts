"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { listApprovalRequests } from "@/lib/queries/approvals";
import { audit } from "@/lib/audit";
import { can, requireUser, type SessionUser } from "@/lib/auth/session";
import { decideApprovalCore, guardSecondApprovalCore, readEnforceConfig, type GuardInput, type GuardResult } from "@/lib/approvals/service";
import { setSettingJson } from "@/lib/settings";
import {
  APPROVAL_ENFORCE_KEY,
  APPROVAL_GROUP_LABEL,
  APPROVAL_GROUP_REASON,
  APPROVAL_GROUPS,
  APPROVAL_GROUPS_WIRED,
  isEnforced,
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
 */
export async function guardSecondApproval(input: GuardInput): Promise<GuardResult> {
  const user = await requireUser();
  const db = await getDb();
  const kq = await guardSecondApprovalCore(db, { id: user.id, email: user.email }, input);
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
export type ApprovalEnforceState = { group: ApprovalGroup; label: string; reason: string; enforced: boolean; wired: boolean };

export async function getApprovalEnforceState(): Promise<ApprovalEnforceState[]> {
  const user = await requireUser();
  if (user.role !== "ADMIN") return [];
  const cfg = await readEnforceConfig(await getDb());
  return APPROVAL_GROUPS.map((g) => ({ group: g, label: APPROVAL_GROUP_LABEL[g], reason: APPROVAL_GROUP_REASON[g], enforced: isEnforced(cfg, g), wired: APPROVAL_GROUPS_WIRED.includes(g) }));
}

export async function setApprovalEnforce(group: string, enforced: boolean): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  // CHỈ ADMIN — không phải `settings:manage`: bật cưỡng chế đổi AI được làm việc một mình, tức là
  // đổi luật kiểm soát của cả shop. Người có quyền cấu hình khác không được tự nới/siết luật đó.
  if (user.role !== "ADMIN") return { error: "Chỉ quản trị viên được bật / tắt cưỡng chế duyệt hai bước" };
  const parsed = setEnforceSchema.safeParse({ group, enforced });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const g = parsed.data.group;
  if (!APPROVAL_GROUPS_WIRED.includes(g)) return { error: `Nhóm "${APPROVAL_GROUP_LABEL[g]}" chưa nối vào thao tác nào — bật lên cũng không chặn được gì` };
  const truoc = (await readEnforceConfig(await getDb())) ?? {};
  const sau: Record<string, unknown> = { ...truoc, [g]: parsed.data.enforced };
  await setSettingJson(APPROVAL_ENFORCE_KEY, sau);
  await audit({
    userId: user.id,
    userEmail: user.email,
    actorKind: "USER",
    action: "approval.enforce",
    entity: "SETTINGS",
    entityId: APPROVAL_ENFORCE_KEY,
    before: truoc,
    after: sau,
    reason: `${parsed.data.enforced ? "BẬT" : "TẮT"} cưỡng chế duyệt hai bước cho nhóm ${APPROVAL_GROUP_LABEL[g]}`,
  });
  revalidatePath("/alerts");
  return { ok: true };
}

export type PendingApproval = {
  id: string;
  group: ApprovalGroup;
  groupLabel: string;
  summary: string;
  amount: number | null;
  requestedByEmail: string;
  requestedAt: Date;
  /** Người đang xem có được duyệt việc này không — người xin thì KHÔNG. */
  canDecide: boolean;
};

export async function listPendingApprovals(limit = 50): Promise<PendingApproval[]> {
  const user = await requireUser();
  const rows = await listApprovalRequests({ limit });
  return rows.map((r) => ({
    id: r.id,
    group: r.group as ApprovalGroup,
    groupLabel: APPROVAL_GROUP_LABEL[r.group as ApprovalGroup] ?? r.group,
    summary: r.summary,
    amount: r.amount ?? null,
    requestedByEmail: r.requestedByEmail,
    requestedAt: r.requestedAt,
    canDecide: coTheDuyet(user) && r.requestedBy !== user.id,
  }));
}
