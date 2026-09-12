"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser, type SessionUser } from "@/lib/auth/session";
import { DEPARTMENT_CODES, type DepartmentCode } from "@/lib/constants/departments";
import { WIP_MAX, WIP_MIN, type StaffingConfig } from "@/lib/constants/workforce";
import { staffingSchema } from "@/lib/validation/workforce";
import { planDistribution, summarizeUnplaced, type DistributionPlan } from "@/lib/work/distribution";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { buildCapacity, getStaffing, holderKeyOf, saveStaffing } from "@/lib/queries/workforce";
import { saveScoreWeights } from "@/lib/queries/work-config";
import { listOrgPeople } from "@/lib/queries/work";
import * as svc from "@/lib/work/service";

/**
 * ═══════════ PHÂN VIỆC: XEM TRƯỚC RỒI MỚI GHI ═══════════
 *
 * Mọi hành động ở đây đi qua đúng một cửa ghi: `svc.assignWork`. Không có đường tắt nào cập nhật
 * thẳng `work_items`, nên mỗi lần đổi chủ đều để lại một dòng ở `work_item_events` — và một việc
 * bị giao nhầm luôn truy ngược được về người bấm nút.
 *
 * ─── VÌ SAO `apply` PHẢI KHAI TƯỜNG MINH ───
 *
 * `autoAssign({ department })` mặc định CHẠY THỬ: nó trả về bản kế hoạch và không ghi gì. Chỉ khi
 * `apply: true` mới ghi. Một nút phân 300 việc mà bấm nhầm là 300 việc mang tên sai người, và gỡ
 * lại tốn nhiều hơn hẳn so với việc nhìn trước một màn hình.
 */

type Result<T = object> = ({ ok: true } & T) | { error: string };

function revalidate() {
  for (const p of ["/work", "/work/today", "/work/department", "/work/all", "/work/performance", "/work/settings", "/"]) revalidatePath(p);
}

function actorOf(user: SessionUser): svc.WorkActor {
  return { id: user.id, email: user.email, name: user.name, source: "UI" };
}

async function authorize(permission: "work:assign" | "work:admin") {
  const user = await requireUser();
  const labels = { "work:assign": "giao việc cho người khác", "work:admin": "cấu hình nhân lực" };
  return { user, error: can(user, permission) ? null : `Bạn không có quyền ${labels[permission]}` };
}

/* ═══════════════════ CẤU HÌNH NHÂN LỰC ═══════════════════ */

/** Sửa MỘT mảnh cấu hình. Gửi cả bảng thì hai người sửa hai ô khác nhau sẽ đè lên nhau. */
export async function patchStaffing(input: unknown): Promise<Result> {
  const { user, error } = await authorize("work:admin");
  if (error) return { error };
  const parsed = staffingSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? `Trần việc phải từ ${WIP_MIN} tới ${WIP_MAX}` };
  const d = parsed.data;

  const cur = await getStaffing();
  const next: StaffingConfig = {
    departmentWip: { ...cur.departmentWip, ...(d.departmentWip ?? {}) },
    userWip: { ...cur.userWip, ...(d.userWip ?? {}) },
    skills: { ...cur.skills, ...(d.skills ?? {}) },
    away: { ...cur.away, ...(d.away ?? {}) },
    autoAssign: { ...cur.autoAssign, ...(d.autoAssign ?? {}) },
    escalationOff: { ...cur.escalationOff, ...(d.escalationOff ?? {}) },
  };
  // Ô kỹ năng RỖNG nghĩa là "nhận mọi loại việc" — phải XOÁ khoá, không phải lưu mảng rỗng, vì
  // mảng rỗng và khoá vắng mặt phải cho cùng một kết quả và chỉ một trong hai nên tồn tại.
  for (const [k, v] of Object.entries(d.skills ?? {})) if (!v.length) delete next.skills[k];
  // Ngày nghỉ để trống = huỷ đăng ký nghỉ.
  for (const [k, v] of Object.entries(d.away ?? {})) if (!v.until) delete next.away[k];

  await saveStaffing(next);
  await audit({ userId: user.id, userEmail: user.email, action: "WORK_STAFFING_SET", entity: "SETTING", entityId: "work.staffing", detail: d });
  revalidate();
  return { ok: true };
}

/**
 * TRỌNG SỐ ĐIỂM TỔNG. Gửi bảng rỗng = TẮT cột điểm tổng, và đó là một lựa chọn hợp lệ — không
 * có điểm tổng vẫn đọc được sáu trục, còn một điểm tổng không ai khai trọng số thì không đọc
 * được gì cả.
 */
export async function setScoreWeights(input: unknown): Promise<Result> {
  const { user, error } = await authorize("work:admin");
  if (error) return { error };
  const parsed = z.object({ outcome: z.number().min(0).max(100).optional(), quality: z.number().min(0).max(100).optional(), sla: z.number().min(0).max(100).optional(), okr: z.number().min(0).max(100).optional() }).safeParse(input);
  if (!parsed.success) return { error: "Trọng số phải từ 0 tới 100" };
  await saveScoreWeights(parsed.data);
  await audit({ userId: user.id, userEmail: user.email, action: "WORK_SCORE_WEIGHTS_SET", entity: "SETTING", entityId: "work.score-weights", detail: parsed.data });
  revalidate();
  return { ok: true };
}

/* ═══════════════════ GIAO VIỆC ═══════════════════ */

/**
 * Giao NHIỀU việc cho MỘT người, có kiểm trần.
 *
 * `force` để trưởng phòng vẫn giao được khi biết rõ mình đang làm gì (ví dụ dồn việc cho người
 * trực ca đêm) — nhưng phải khai tường minh, và số việc vượt trần được ghi vào `audit`. Không có
 * `force` thì phần vượt trần bị TỪ CHỐI chứ không âm thầm cắt bớt: cắt bớt im lặng nghĩa là người
 * bấm tưởng đã giao 40 việc trong khi chỉ 12 việc có chủ.
 */
export async function bulkAssign(input: unknown): Promise<Result<{ assigned: number; skipped: number }>> {
  const { user, error } = await authorize("work:assign");
  if (error) return { error };
  const parsed = z.object({ keys: z.array(z.string().min(3)).min(1).max(200), userId: z.string().min(1), force: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return { error: "Danh sách việc hoặc người nhận không hợp lệ" };
  const { keys, userId, force } = parsed.data;

  const now = new Date();
  const [{ items }, people, cfg] = await Promise.all([collectWorkItems({ now }), listOrgPeople(), getStaffing()]);
  const nguoi = people.find((p) => p.id === userId);
  if (!nguoi) return { error: "Người nhận không có trong danh sách nhân sự đang hoạt động" };

  const open = items.filter((i) => i.status !== "DONE" && i.status !== "CANCELLED");
  const cap = buildCapacity(people, open, cfg, now);
  const row = cap.find((r) => r.userId === userId);
  const free = row?.free ?? 0;

  if (!force && keys.length > free) {
    return {
      error:
        row && row.away
          ? `${nguoi.name} đang khai nghỉ tới ${new Date(row.away.until).toLocaleDateString("vi-VN")}. Bỏ đăng ký nghỉ hoặc chọn người khác.`
          : `${nguoi.name} chỉ còn ${free} chỗ (đang cầm ${row?.load ?? 0}/${row?.limit ?? 0}). Chọn ít việc hơn, nâng trần, hoặc tích "giao vượt trần".`,
    };
  }

  let assigned = 0;
  let skipped = 0;
  for (const key of keys) {
    const r = await svc.assignWork(key, userId, actorOf(user));
    if ("error" in r) skipped += 1;
    else assigned += 1;
  }

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "WORK_BULK_ASSIGN",
    entity: "WORK_ITEM",
    entityId: userId,
    detail: { assigned, skipped, requested: keys.length, force: force ?? false, freeBefore: free, limit: row?.limit ?? null },
  });
  revalidate();
  return { ok: true, assigned, skipped };
}

/** Chuyển một việc từ người này sang người khác (hoặc trả về hàng đợi phòng khi `userId` rỗng). */
export async function reassignWork(input: unknown): Promise<Result> {
  const { user, error } = await authorize("work:assign");
  if (error) return { error };
  const parsed = z.object({ key: z.string().min(3), userId: z.string().min(1).nullable() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await svc.assignWork(parsed.data.key, parsed.data.userId, actorOf(user));
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "WORK_REASSIGN", entity: "WORK_ITEM", entityId: parsed.data.key, detail: { to: parsed.data.userId } });
  revalidate();
  return { ok: true };
}

/* ═══════════════════ PHÂN VIỆC TỰ ĐỘNG ═══════════════════ */

export type AutoAssignResult = {
  plan: Omit<DistributionPlan, "unplaced"> & { unplaced: DistributionPlan["unplaced"] };
  summary: ReturnType<typeof summarizeUnplaced>;
  applied: number;
  failed: number;
  dryRun: boolean;
};

/**
 * Phân việc chưa ai nhận trong MỘT phòng.
 *
 * Mặc định CHẠY THỬ. Kế hoạch trả về đủ để vẽ màn hình xem trước: ai nhận việc nào, vì sao, và
 * sau khi áp thì mỗi người cầm bao nhiêu so với trần.
 */
export async function autoAssign(input: unknown): Promise<Result<AutoAssignResult>> {
  const { user, error } = await authorize("work:assign");
  if (error) return { error };
  const parsed = z.object({ department: z.enum(DEPARTMENT_CODES), apply: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }).safeParse(input);
  if (!parsed.success) return { error: "Phòng ban không hợp lệ" };
  const department = parsed.data.department as DepartmentCode;
  const apply = parsed.data.apply === true;

  const now = new Date();
  const [{ items }, people, cfg] = await Promise.all([collectWorkItems({ now }), listOrgPeople(), getStaffing()]);
  const open = items.filter((i) => i.status !== "DONE" && i.status !== "CANCELLED");
  const capacity = buildCapacity(people, open, cfg, now, department);
  // CHỈ việc chưa ai cầm. Máy không bao giờ lấy việc khỏi tay người đang giữ — đó là `reassignWork`.
  const canGiao = open.filter((i) => i.department === department && holderKeyOf(i) === null);

  const plan = planDistribution(department, canGiao, capacity, cfg, now, { limit: parsed.data.limit });

  let applied = 0;
  let failed = 0;
  if (apply) {
    for (const a of plan.assignments) {
      const r = await svc.assignWork(a.key, a.userId, actorOf(user));
      if ("error" in r) failed += 1;
      else applied += 1;
    }
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: "WORK_AUTO_ASSIGN",
      entity: "DEPARTMENT",
      entityId: department,
      detail: { planned: plan.assignments.length, applied, failed, unplaced: plan.unplaced.length },
    });
    revalidate();
  }

  return { ok: true, plan, summary: summarizeUnplaced(plan.unplaced), applied, failed, dryRun: !apply };
}
