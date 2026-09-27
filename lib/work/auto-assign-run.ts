import { audit } from "@/lib/audit";
import { DEPARTMENT_CODES, type DepartmentCode } from "@/lib/constants/departments";
import { autoAssignOn } from "@/lib/constants/workforce";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { listOrgPeople } from "@/lib/queries/work";
import { buildCapacity, getStaffing, holderKeyOf } from "@/lib/queries/workforce";
import { assignByMachine, MACHINE_ASSIGNER, machineAssignable } from "@/lib/work/assign";
import { planDistribution, type DistributionPlan } from "@/lib/work/distribution";

/**
 * ═══════════ PHÂN VIỆC TỰ ĐỘNG CHẠY NỀN ═══════════
 *
 * Công tắc "Phân việc tự động" ở Cấu hình → Sức chứa đã có từ bản workforce v2 và in chữ "chạy
 * nền" — nhưng không job nào đọc nó: bật lên thì không có gì xảy ra. Tệp này là phần còn thiếu.
 *
 * Nó KHÔNG có luật chọn người của riêng mình. Kế hoạch dựng bằng `buildDepartmentPlan`, đúng hàm
 * mà nút "Phân việc tự động" (có xem trước) dùng, nên thứ người quản lý nhìn thấy khi chạy thử là
 * thứ job làm — không có hai bộ luật cho một câu hỏi "giao cho ai".
 *
 * Giữ nguyên mọi rào của máy phân việc (AGENTS.md mục 25):
 *  · CHỈ việc chưa ai cầm; ai vừa nhận giữa lúc dựng và lúc ghi thì người thắng.
 *  · Không nhồi quá trần; người đang khai nghỉ không nhận. Phần thừa NẰM LẠI hàng đợi phòng.
 *  · Phòng nào chưa bật công tắc thì không đụng tới — mặc định TẮT ở mọi phòng.
 */

export type DepartmentPlanInput = {
  department: DepartmentCode;
  now: Date;
  limit?: number;
  /** Job nền: bỏ nguồn máy chưa có đường ghi, để chúng không chiếm chỗ trong kế hoạch. */
  machineOnly?: boolean;
};

export async function buildDepartmentPlan(input: DepartmentPlanInput): Promise<{ plan: DistributionPlan; notMachineAssignable: number }> {
  const { department, now } = input;
  const [{ items }, people, cfg] = await Promise.all([collectWorkItems({ now }), listOrgPeople(), getStaffing()]);
  const open = items.filter((i) => i.status !== "DONE" && i.status !== "CANCELLED");
  const capacity = buildCapacity(people, open, cfg, now, department);
  // CHỈ việc chưa ai cầm. Máy không bao giờ lấy việc khỏi tay người đang giữ — đó là `reassignWork`.
  const trong = open.filter((i) => i.department === department && holderKeyOf(i) === null);
  const canGiao = input.machineOnly ? trong.filter((i) => machineAssignable(i.sourceType)) : trong;
  return {
    plan: planDistribution(department, canGiao, capacity, cfg, now, { limit: input.limit }),
    notMachineAssignable: trong.length - canGiao.length,
  };
}

export type AutoAssignRunDepartment = {
  department: DepartmentCode;
  planned: number;
  applied: number;
  failed: number;
  unplaced: number;
  notMachineAssignable: number;
  /** Lý do lỗi ghi, gộp theo câu — để người đọc nhật ký job thấy VÌ SAO, không chỉ bao nhiêu. */
  failures: { reason: string; count: number }[];
};

export type AutoAssignRunResult = { departments: AutoAssignRunDepartment[]; enabled: DepartmentCode[] };

export async function runAutoAssign(now: Date = new Date()): Promise<AutoAssignRunResult> {
  const cfg = await getStaffing();
  const enabled = DEPARTMENT_CODES.filter((d) => autoAssignOn(d, cfg));
  const departments: AutoAssignRunDepartment[] = [];

  for (const department of enabled) {
    const { plan, notMachineAssignable } = await buildDepartmentPlan({ department, now, machineOnly: true });
    let applied = 0;
    const loi = new Map<string, number>();
    for (const a of plan.assignments) {
      const r = await assignByMachine(a.key, a.userId);
      if ("error" in r) loi.set(r.error, (loi.get(r.error) ?? 0) + 1);
      else applied += 1;
    }
    const failed = plan.assignments.length - applied;
    const failures = [...loi.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
    departments.push({ department, planned: plan.assignments.length, applied, failed, unplaced: plan.unplaced.length, notMachineAssignable, failures });

    // Lượt không giao được việc nào thì không ghi nhật ký: 144 dòng "0 việc" mỗi ngày là tiếng ồn
    // che mất lượt có việc. `sync_runs` của job vẫn giữ dấu vết mọi lượt chạy.
    if (plan.assignments.length) {
      await audit({
        userId: null,
        userEmail: MACHINE_ASSIGNER.email,
        action: "WORK_AUTO_ASSIGN",
        entity: "DEPARTMENT",
        entityId: department,
        detail: {
          trigger: "SCHEDULER",
          planned: plan.assignments.length,
          applied,
          failed,
          unplaced: plan.unplaced.length,
          notMachineAssignable,
          assignments: plan.assignments.slice(0, 50).map((a) => ({ key: a.key, userId: a.userId })),
        },
      });
    }
  }
  return { departments, enabled };
}
