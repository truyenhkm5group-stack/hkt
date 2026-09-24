import { DEPARTMENT_LABEL, DEPARTMENT_ORDER, type DepartmentCode } from "@/lib/constants/departments";
import { slaStateOf, sumMoney, type WorkItem } from "@/lib/constants/work";
import { WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";
import { escalationOf, sortByEscalation, type Escalation } from "@/lib/work/escalation";
import { pickMorningWork, type MorningPicks } from "@/lib/work/morning-picks";
import { diagnoseOverdue, type OverdueDiagnosis } from "@/lib/work/overdue-diagnosis";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { listOrgPeople } from "@/lib/queries/work";
import { buildCapacity, getStaffing, holderKeyOf, type CapacityRow } from "@/lib/queries/workforce";
import type { StaffingConfig } from "@/lib/constants/workforce";

/**
 * ═══════════ MÀN HÌNH SÁNG CỦA TRƯỞNG PHÒNG ═══════════
 *
 * Bảy khối, theo đúng thứ tự người ta hỏi khi mở máy: **tồn đọng · quá hạn · chưa ai nhận · tải
 * theo người · tiền đang treo · việc bị chặn · năm việc phải can thiệp ngay.**
 *
 * ─── VÌ SAO LÀ MỘT TRANG RIÊNG, KHÔNG NHỒI VÀO `/work/department` ───
 *
 * Hai trang trả lời hai câu hỏi khác nhau và mở vào hai lúc khác nhau. `/work/department` là chỗ
 * ĐÀO SÂU một phòng: toàn bộ hàng đợi, bảng tải, thống kê 30 ngày — mở khi cần tìm một việc cụ
 * thể. Trang này là chỗ nhìn 30 giây đầu ca để biết **hôm nay phải chạm vào cái gì**, và nó cắt
 * ngang mọi phòng cho người có quyền nhìn chéo. Nhồi cả hai vào một trang thì phần nào cũng dài
 * và không phần nào đọc được trong 30 giây.
 *
 * ─── "CẦN CAN THIỆP" KHÔNG PHẢI "GẤP NHẤT" ───
 *
 * Năm dòng cuối KHÔNG phải năm việc điểm cao nhất — đó đã là đầu hàng đợi và người làm tự thấy.
 * Đây là việc mà **người làm không tự gỡ được**: bị chặn, vỡ hạn lâu mà chưa ai cầm, hoặc đang
 * nằm trong tay một người đã quá tải. Ba tình huống đó đều cần một quyết định của trưởng phòng —
 * gỡ chặn, giao người, hoặc chuyển việc đi.
 */

export type InterventionKind = "BLOCKED" | "STALE_UNASSIGNED" | "OVERLOADED_HOLDER" | "NO_DEPARTMENT_STAFF";

export const INTERVENTION_LABEL: Record<InterventionKind, string> = {
  BLOCKED: "Bị chặn",
  STALE_UNASSIGNED: "Vỡ hạn lâu, chưa ai nhận",
  OVERLOADED_HOLDER: "Người đang cầm đã quá tải",
  NO_DEPARTMENT_STAFF: "Phòng chưa có ai",
};

export const INTERVENTION_ACTION: Record<InterventionKind, string> = {
  BLOCKED: "Đọc lý do chặn và gỡ — đây là nút thắt NỘI BỘ, không phải chờ bên ngoài.",
  STALE_UNASSIGNED: "Giao cho người cụ thể. Để ở hàng đợi chung thêm một ngày nữa thì kết quả sẽ y như hôm qua.",
  OVERLOADED_HOLDER: "Chuyển bớt sang người còn chỗ, hoặc nâng trần nếu người đó thật sự làm nổi.",
  NO_DEPARTMENT_STAFF: "Xếp người vào phòng ở Cấu hình → Nhân sự và phòng ban. Không ai trong phòng thì không ai nhận được việc.",
};

export type Intervention = {
  key: string;
  title: string;
  department: DepartmentCode;
  source: WorkSource;
  sourceLabel: string;
  kind: InterventionKind;
  detail: string;
  holder: string;
  moneyAtRisk: number | null;
  url: string;
  escalation: Escalation | null;
};

export type ManagerDay = {
  scope: DepartmentCode | null;
  label: string;
  backlog: number;
  overdue: number;
  unassigned: number;
  blocked: number;
  waiting: number;
  /** Sắp vỡ hạn trong vài giờ tới — con số duy nhất còn CỨU ĐƯỢC bằng hành động hôm nay. */
  dueSoon: number;
  money: ReturnType<typeof sumMoney>;
  capacity: CapacityRow[];
  overloaded: number;
  freeSlots: number;
  interventions: Intervention[];
  bySource: { source: WorkSource; label: string; open: number; overdue: number; unassigned: number }[];
  /** Phòng có việc nhưng KHÔNG có người nào — lỗ hổng chặn mọi thứ khác. */
  emptyDepartments: { department: DepartmentCode; label: string; open: number }[];
  failedSources: { source: WorkSource; error: string }[];
  cfg: StaffingConfig;
  /** Ba việc đáng làm nhất, xếp LIÊN PHÒNG. Chỉ có ở chế độ xem toàn shop — trong một phòng thì đó đã là đầu hàng đợi. */
  morning: MorningPicks | null;
  /** Vì sao quá hạn, từng phòng trong phạm vi — `lib/work/overdue-diagnosis.ts`. */
  diagnosis: OverdueDiagnosis[];
};

export function buildInterventions(items: WorkItem[], capacity: CapacityRow[], now: Date, emptyDepts: Set<DepartmentCode>): Intervention[] {
  const quaTai = new Set(capacity.filter((c) => c.overloaded).map((c) => c.userId));
  const ra: Intervention[] = [];

  for (const i of sortByEscalation(items, now)) {
    const esc = escalationOf(i, now);
    const holder = i.assignee?.name ?? "";
    let kind: InterventionKind | null = null;
    let detail = "";

    if (i.status === "BLOCKED") {
      kind = "BLOCKED";
      detail = i.blockedReason || "chưa ghi lý do chặn";
    } else if (!i.assignee && emptyDepts.has(i.department)) {
      kind = "NO_DEPARTMENT_STAFF";
      detail = `${DEPARTMENT_LABEL[i.department]} chưa có thành viên nào`;
    } else if (esc?.level === "STALE") {
      kind = "STALE_UNASSIGNED";
      detail = `vỡ hạn ${Math.round(esc.hours)} giờ, chưa ai cầm`;
    } else if (i.assignee?.id && quaTai.has(i.assignee.id)) {
      const c = capacity.find((x) => x.userId === i.assignee!.id)!;
      kind = "OVERLOADED_HOLDER";
      detail = `${c.name} đang cầm ${c.load}/${c.limit}${c.overdue ? `, ${c.overdue} việc quá hạn` : ""}`;
    }
    if (!kind) continue;

    ra.push({
      key: i.key,
      title: i.title,
      department: i.department,
      source: i.sourceType as WorkSource,
      sourceLabel: WORK_SOURCE_SPEC[i.sourceType as WorkSource]?.label ?? i.sourceType,
      kind,
      detail,
      holder,
      moneyAtRisk: i.money.atRisk,
      url: i.sourceUrl,
      escalation: esc,
    });
    if (ra.length >= 5) break;
  }
  return ra;
}

export async function getManagerDay(scope: DepartmentCode | null, now: Date = new Date()): Promise<ManagerDay> {
  const [{ items, failed }, people, cfg] = await Promise.all([collectWorkItems({ now }), listOrgPeople(), getStaffing()]);
  const open = items.filter((i) => i.status !== "DONE" && i.status !== "CANCELLED");

  /*
    SỐ NGƯỜI TÍNH TRÊN TOÀN SHOP, VIỆC TÍNH THEO PHẠM VI ĐANG XEM.

    Phòng "chưa có ai" phải phát hiện được kể cả khi trưởng phòng đang xem phòng khác — đó là lỗ
    hổng chặn mọi thứ, và nó không được chỉ hiện khi vô tình mở đúng phòng đó.
  */
  const coNguoi = new Set<DepartmentCode>();
  for (const p of people) for (const d of p.departments) coNguoi.add(d.code);
  const moTheoPhong = new Map<DepartmentCode, number>();
  for (const i of open) moTheoPhong.set(i.department, (moTheoPhong.get(i.department) ?? 0) + 1);
  const emptyDepartments = DEPARTMENT_ORDER.filter((d) => !coNguoi.has(d) && (moTheoPhong.get(d) ?? 0) > 0).map((d) => ({
    department: d,
    label: DEPARTMENT_LABEL[d],
    open: moTheoPhong.get(d) ?? 0,
  }));
  const emptySet = new Set(emptyDepartments.map((e) => e.department));

  const trongPham = scope ? open.filter((i) => i.department === scope) : open;
  const capacity = buildCapacity(people, open, cfg, now, scope);

  const bySourceMap = new Map<WorkSource, WorkItem[]>();
  for (const i of trongPham) bySourceMap.set(i.sourceType as WorkSource, [...(bySourceMap.get(i.sourceType as WorkSource) ?? []), i]);

  const quaHan = trongPham.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) === "BREACHED");

  return {
    scope,
    label: scope ? DEPARTMENT_LABEL[scope] : "Toàn shop",
    backlog: trongPham.length,
    overdue: quaHan.length,
    unassigned: trongPham.filter((i) => holderKeyOf(i) === null).length,
    blocked: trongPham.filter((i) => i.status === "BLOCKED").length,
    waiting: trongPham.filter((i) => i.status === "WAITING").length,
    dueSoon: trongPham.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) === "DUE_SOON").length,
    money: sumMoney(trongPham),
    capacity,
    overloaded: capacity.filter((c) => c.overloaded).length,
    freeSlots: capacity.filter((c) => !c.away).reduce((s, c) => s + c.free, 0),
    interventions: buildInterventions(trongPham, capacity, now, emptySet),
    bySource: [...bySourceMap.entries()]
      .map(([source, list]) => ({
        source,
        label: WORK_SOURCE_SPEC[source]?.label ?? source,
        open: list.length,
        overdue: list.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) === "BREACHED").length,
        unassigned: list.filter((i) => holderKeyOf(i) === null).length,
      }))
      .sort((a, b) => b.overdue - a.overdue || b.open - a.open),
    emptyDepartments,
    failedSources: failed,
    cfg,
    morning: scope ? null : pickMorningWork(open, now),
    diagnosis: diagnoseOverdue(open, capacity, cfg, now, scope),
  };
}

/** Phòng mà người này được xem ở màn hình sáng. `null` = toàn shop. */
export function scopeFor(crossDept: boolean, mine: DepartmentCode[], requested: string): DepartmentCode | null {
  if (!requested) return crossDept ? null : (mine[0] ?? null);
  const d = requested as DepartmentCode;
  if (crossDept) return DEPARTMENT_ORDER.includes(d) ? d : null;
  // Trưởng phòng chỉ mở được phòng mình — màn hình sáng không được là cửa sau xem phòng khác.
  return mine.includes(d) ? d : (mine[0] ?? null);
}

export { DEPARTMENT_ORDER };
