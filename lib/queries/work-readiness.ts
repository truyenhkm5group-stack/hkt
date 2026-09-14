import { DEPARTMENT_LABEL, DEPARTMENT_ORDER, type DepartmentCode } from "@/lib/constants/departments";
import { slaStateOf, sumMoney, type WorkItem } from "@/lib/constants/work";
import { WORK_ACTION, type WorkActionKey } from "@/lib/constants/work-actions";
import { ALERT_TYPES_WITHOUT_OWNER, DEFAULT_OWNERSHIP_MAP, DEFAULT_OWNERSHIP_RULES, SOURCES_WITHOUT_OWNER } from "@/lib/constants/work-ownership";
import { ALERT_TYPES_WITHOUT_SLA, DEFAULT_SLA_MAP, DEFAULT_SLA_RULES, SOURCES_WITHOUT_SLA } from "@/lib/constants/work-sla";
import { WORK_SOURCES, WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { getWorkConfig } from "@/lib/queries/work-config";
import { listDepartments, listOrgPeople } from "@/lib/queries/work";

/**
 * ═══════════ MỨC SẴN SÀNG VẬN HÀNH — ĐO CHÍNH CÁI HỆ THỐNG CÔNG VIỆC ═══════════
 *
 * Câu hỏi mà báo cáo này trả lời không phải "shop đang bán ra sao", mà: **ngày mai nhân viên mở
 * `/work` lên thì nó có dùng được không?**
 *
 * Ba nhóm số, và nhóm thứ ba là nhóm quan trọng nhất:
 *
 *  1. **Khối lượng thật** — bao nhiêu việc, ở phòng nào, bao nhiêu chưa ai nhận, bao nhiêu quá hạn,
 *     bao nhiêu tiền đang treo.
 *  2. **Độ phủ hạn xử lý** — bao nhiêu phần trăm việc CÓ hạn. Thấp nghĩa là con số "quá hạn" ở trên
 *     đang nói về một mảnh nhỏ, và trưởng phòng đang lái bằng một đồng hồ chỉ đo một phần.
 *  3. **Lỗ hổng khai báo** — nguồn nào chưa có phòng chịu trách nhiệm, chưa có hạn, chưa có nút bấm
 *     thật; phòng nào chưa có trưởng; ai chưa có phòng. Đây là DANH SÁCH VIỆC PHẢI LÀM của chủ shop
 *     trước ngày đầu tiên, chứ không phải một con số để ngắm.
 *
 * ─── KHÔNG LÀM TRÒN LÊN ───
 *
 * Nguồn nào không đọc được thì được nêu tên ở `failedSources` và số của nó KHÔNG được coi là 0.
 * Một báo cáo "sẵn sàng 100%" dựng trên ba nguồn im lặng là loại báo cáo tệ nhất.
 */

export type SourceReadiness = {
  source: WorkSource;
  label: string;
  count: number;
  overdue: number;
  unassigned: number;
  /** Có luật phòng ban (mức nguồn hoặc mức loại) không. */
  hasOwnerRule: boolean;
  /** Có luật hạn xử lý (mức nguồn hoặc mức loại) không. */
  hasSlaRule: boolean;
  /** Việc của nguồn này thật sự CÓ hạn (đếm trên dữ liệu, không đếm trên khai báo). */
  withSla: number;
  /**
   * Nút RIÊNG của nguồn gọi thẳng Server Action của miền nghiệp vụ (`DOMAIN`).
   *
   * Không đếm bốn nút chung của lớp công việc (nhận việc, ghi chú, hoãn, báo chặn): nguồn nào cũng
   * có chúng, nên đếm vào thì mọi nguồn đều trông như đã xử lý được tại chỗ. Con số này trả lời
   * câu hỏi hẹp hơn và đúng hơn: *xử lý XONG việc này ngay trên dòng được không, hay phải sang
   * màn hình khác?*
   */
  domainActions: number;
  /** Vì sao nguồn này chưa sẵn sàng. Rỗng = không thiếu gì. */
  gap: string;
};

export type ReadinessReport = {
  total: number;
  unassigned: number;
  overdue: number;
  money: ReturnType<typeof sumMoney>;
  byDepartment: { department: DepartmentCode; label: string; count: number; unassigned: number; overdue: number; members: number; leadName: string }[];
  slaCoverage: { withSla: number; withoutSla: number; rate: number | null };
  sources: SourceReadiness[];
  gaps: {
    sourcesWithoutSla: string[];
    sourcesWithoutOwner: string[];
    alertTypesWithoutSla: string[];
    alertTypesWithoutOwner: string[];
    sourcesWithoutRealAction: string[];
    departmentsWithoutLead: string[];
    departmentsWithoutMember: string[];
    peopleWithoutDepartment: string[];
  };
  /** Bao nhiêu luật đã được chủ shop sửa khỏi mặc định — dấu hiệu hệ thống đang được dùng thật. */
  overrides: { sla: number; ownership: number };
  failedSources: { source: WorkSource; error: string }[];
};

function hasRule(map: Record<string, unknown>, rules: { key: string }[], source: WorkSource): boolean {
  return Boolean(map[source]) || rules.some((r) => r.key.startsWith(`${source}:`));
}

export async function getReadiness(now: Date = new Date()): Promise<ReadinessReport> {
  const [{ items, failed }, departments, people, cfg] = await Promise.all([
    collectWorkItems({ now }),
    listDepartments(),
    listOrgPeople(),
    getWorkConfig(),
  ]);

  const laQuaHan = (i: WorkItem) => slaStateOf(i.slaAt ?? i.dueAt, now) === "BREACHED";
  const coHan = (i: WorkItem) => (i.slaAt ?? i.dueAt) !== null;

  const byDeptItems = new Map<DepartmentCode, WorkItem[]>();
  for (const i of items) byDeptItems.set(i.department, [...(byDeptItems.get(i.department) ?? []), i]);

  const bySource = new Map<WorkSource, WorkItem[]>();
  for (const i of items) bySource.set(i.sourceType as WorkSource, [...(bySource.get(i.sourceType as WorkSource) ?? []), i]);

  const memberCount = new Map<DepartmentCode, number>();
  for (const p of people) for (const d of p.departments) memberCount.set(d.code, (memberCount.get(d.code) ?? 0) + 1);

  const sources: SourceReadiness[] = WORK_SOURCES.map((source) => {
    const list = bySource.get(source) ?? [];
    const hasOwnerRule = WORK_SOURCE_SPEC[source].department === null || hasRule(DEFAULT_OWNERSHIP_MAP, DEFAULT_OWNERSHIP_RULES, source);
    const hasSlaRule = hasRule(DEFAULT_SLA_MAP, DEFAULT_SLA_RULES, source);
    /*
      ĐẾM NÚT RIÊNG CỦA NGUỒN, KHÔNG ĐẾM NÚT CHUNG.

      Mọi nguồn đều được cấp bốn nút của lớp công việc (nhận việc, ghi chú, hoãn, báo chặn). Đếm cả
      chúng thì nguồn nào cũng "có hành động" và con số mất hết ý nghĩa — bản đầu của báo cáo này
      đã mắc đúng lỗi đó. Chỉ đếm nút nguồn TỰ khai và gọi được Server Action của miền: đó mới là
      "xử lý xong ngay trên dòng".

      Nguồn do `work_items` sở hữu (việc tay, việc định kỳ) KHÔNG cần nút miền — trạng thái của
      chúng nằm ngay ở lớp công việc — nên chúng không bị tính là lỗ hổng.
    */
    const domainActions = WORK_SOURCE_SPEC[source].actions.filter((a: WorkActionKey) => WORK_ACTION[a]?.mode === "DOMAIN").length;
    const canDomainAction = WORK_SOURCE_SPEC[source].statusAuthority === "SOURCE";
    const withSla = list.filter(coHan).length;
    const thieu: string[] = [];
    if (!hasOwnerRule) thieu.push("chưa có luật phòng ban");
    if (!hasSlaRule) thieu.push("chưa có luật hạn xử lý");
    if (canDomainAction && !domainActions) thieu.push("chưa xử lý xong được ngay trên dòng — phải mở sang màn hình gốc");
    if (list.length && !withSla) thieu.push("không việc nào có hạn");
    return {
      source,
      label: WORK_SOURCE_SPEC[source].label,
      count: list.length,
      overdue: list.filter(laQuaHan).length,
      unassigned: list.filter((i) => !i.assignee).length,
      hasOwnerRule,
      hasSlaRule,
      withSla,
      domainActions,
      gap: thieu.join(" · "),
    };
  }).sort((a, b) => b.count - a.count);

  const withSla = items.filter(coHan).length;

  return {
    total: items.length,
    unassigned: items.filter((i) => !i.assignee).length,
    overdue: items.filter(laQuaHan).length,
    money: sumMoney(items),
    byDepartment: DEPARTMENT_ORDER.map((department) => {
      const list = byDeptItems.get(department) ?? [];
      const d = departments.find((x) => x.code === department);
      return {
        department,
        label: DEPARTMENT_LABEL[department],
        count: list.length,
        unassigned: list.filter((i) => !i.assignee).length,
        overdue: list.filter(laQuaHan).length,
        members: memberCount.get(department) ?? 0,
        leadName: d?.leadName ?? "",
      };
    }),
    slaCoverage: { withSla, withoutSla: items.length - withSla, rate: items.length ? withSla / items.length : null },
    sources,
    gaps: {
      sourcesWithoutSla: SOURCES_WITHOUT_SLA.map((s) => WORK_SOURCE_SPEC[s].label),
      sourcesWithoutOwner: SOURCES_WITHOUT_OWNER.map((s) => WORK_SOURCE_SPEC[s].label),
      alertTypesWithoutSla: ALERT_TYPES_WITHOUT_SLA,
      alertTypesWithoutOwner: ALERT_TYPES_WITHOUT_OWNER,
      sourcesWithoutRealAction: sources.filter((s) => WORK_SOURCE_SPEC[s.source].statusAuthority === "SOURCE" && !s.domainActions).map((s) => s.label),
      departmentsWithoutLead: departments.filter((d) => !d.leadUserId).map((d) => d.name),
      departmentsWithoutMember: departments.filter((d) => (memberCount.get(d.code) ?? 0) === 0).map((d) => d.name),
      peopleWithoutDepartment: people.filter((p) => p.departments.length === 0).map((p) => p.name || p.email),
    },
    overrides: { sla: Object.keys(cfg.sla).length, ownership: Object.keys(cfg.ownership).length },
    failedSources: failed,
  };
}
