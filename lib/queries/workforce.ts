import { memo } from "@/lib/cache";
import { DEPARTMENT_CODES, type DepartmentCode } from "@/lib/constants/departments";
import { holderKeyOf, slaStateOf, sumMoney, type WorkItem } from "@/lib/constants/work";
import { isWorkSource, type WorkSource } from "@/lib/constants/work-sources";
import {
  WIP_MAX,
  WIP_MIN,
  WIP_NEAR_FULL_SLOTS,
  WORK_STAFFING_KEY,
  handlesSource,
  isAway,
  wipLimitOf,
  type StaffingConfig,
} from "@/lib/constants/workforce";
import { listOrgPeople, type OrgPerson } from "@/lib/queries/work";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ AI CÒN CHỖ, AI ĐANG QUÁ TẢI ═══════════
 *
 * Một dòng cho mỗi người: họ đang cầm bao nhiêu, trần là bao nhiêu, còn mấy chỗ, và nếu không còn
 * chỗ thì vì sao.
 *
 * ─── "QUÁ TẢI" KHÔNG PHẢI "NHIỀU VIỆC" ───
 *
 * Một người cầm 18/20 việc đúng hạn đang chạy tốt. Một người cầm 6 việc mà 4 việc quá hạn thì
 * đang chìm. Nên `overloaded` xét CẢ HAI: vượt trần, HOẶC quá nửa số việc đang cầm đã vỡ hạn.
 * Thiếu vế thứ hai thì màn hình trưởng phòng sẽ báo "còn chỗ" cho đúng người đang cần gỡ việc ra.
 */

export type CapacityRow = {
  userId: string;
  name: string;
  email: string;
  departments: DepartmentCode[];
  /** Việc đang cầm (chưa đóng). */
  load: number;
  overdue: number;
  blocked: number;
  waiting: number;
  limit: number;
  /** Số chỗ còn nhận thêm được. Không bao giờ âm ở đây — vượt trần thì xem `over`. */
  free: number;
  /** Đang cầm quá trần bao nhiêu việc. `0` = không vượt. */
  over: number;
  away: { until: string; reason: string } | null;
  /** Loại việc người này nhận. Rỗng = nhận mọi loại của phòng. */
  skills: WorkSource[];
  /** Vượt trần HOẶC quá nửa việc đang cầm đã vỡ hạn. */
  overloaded: boolean;
  nearFull: boolean;
  money: ReturnType<typeof sumMoney>;
};

/* ═══════════════════ ĐỌC / GHI CẤU HÌNH ═══════════════════ */

function sanitizeWip(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  return v < WIP_MIN || v > WIP_MAX ? null : v;
}

/**
 * Dòng rác trong `settings` không được làm sập màn hình công việc của cả shop.
 * Khoá hỏng bị bỏ, phần còn lại giữ nguyên — mất một ghi đè còn hơn mất cả hàng đợi.
 */
export function sanitizeStaffing(raw: unknown): StaffingConfig {
  const out: StaffingConfig = { departmentWip: {}, userWip: {}, skills: {}, away: {}, autoAssign: {}, escalationOff: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;

  const deptWip = (o.departmentWip ?? {}) as Record<string, unknown>;
  for (const d of DEPARTMENT_CODES) {
    const v = sanitizeWip(deptWip[d]);
    if (v !== null) out.departmentWip[d] = v;
  }
  const userWip = (o.userWip ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(userWip)) {
    const n = sanitizeWip(v);
    if (k && n !== null) out.userWip[k] = n;
  }
  const skills = (o.skills ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(skills)) {
    if (!k || !Array.isArray(v)) continue;
    const ds = v.filter((s): s is WorkSource => typeof s === "string" && isWorkSource(s));
    if (ds.length) out.skills[k] = ds;
  }
  const away = (o.away ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(away)) {
    if (!k || !v || typeof v !== "object") continue;
    const e = v as { until?: unknown; reason?: unknown };
    if (typeof e.until !== "string" || Number.isNaN(new Date(e.until).getTime())) continue;
    out.away[k] = { until: e.until, reason: typeof e.reason === "string" ? e.reason.slice(0, 200) : "" };
  }
  const auto = (o.autoAssign ?? {}) as Record<string, unknown>;
  for (const d of DEPARTMENT_CODES) if (auto[d] === true) out.autoAssign[d] = true;
  const esc = (o.escalationOff ?? {}) as Record<string, unknown>;
  for (const d of DEPARTMENT_CODES) if (esc[d] === true) out.escalationOff[d] = true;
  return out;
}

/** 60 giây — cùng nhịp với `getWorkConfig()`; Server Action lưu xong gọi `revalidatePath`. */
export async function getStaffing(): Promise<StaffingConfig> {
  return memo("work-staffing", 60_000, async () => sanitizeStaffing(await getSettingJson<Record<string, unknown>>(WORK_STAFFING_KEY, {})));
}

export async function saveStaffing(next: StaffingConfig): Promise<void> {
  await setSettingJson(WORK_STAFFING_KEY, sanitizeStaffing(next));
}

/* ═══════════════════ SỨC CHỨA ═══════════════════ */

/** Ai đang cầm việc này — định nghĩa ở `lib/constants/work.ts`, xuất lại để mã gọi cũ không đổi. */
export { holderKeyOf };

/**
 * Bảng sức chứa của một phòng (hoặc toàn shop khi `department` rỗng).
 *
 * CHỈ tính việc ĐANG MỞ: việc đã đóng không chiếm chỗ của ai nữa. Và chỉ tính người CÓ TRONG
 * PHÒNG — người ngoài phòng có cầm việc của phòng này thì vẫn hiện ở bảng tải, nhưng máy phân
 * việc không giao thêm cho họ (xem `lib/work/distribution.ts`).
 */
export function buildCapacity(
  people: OrgPerson[],
  openItems: WorkItem[],
  cfg: StaffingConfig,
  now: Date,
  department?: DepartmentCode | null,
): CapacityRow[] {
  const ofDept = department ? people.filter((p) => p.departments.some((d) => d.code === department)) : people;
  const theoNguoi = new Map<string, WorkItem[]>();
  for (const i of openItems) {
    const k = holderKeyOf(i);
    if (k) theoNguoi.set(k, [...(theoNguoi.get(k) ?? []), i]);
  }

  return ofDept
    .map((p) => {
      /*
        GHÉP CẢ HAI CHIỀU: theo khoá người dùng, và theo TÊN.

        `cs_cases.assignee` là một ô CHỮ (tên hoặc bí danh do Pancake ghi), không phải khoá người
        dùng — đo trên production: 88/384 case đang mở có tên ở ô đó. Bỏ qua chúng thì bảng sức
        chứa sẽ báo người đó đang rảnh trong khi họ đang ôm mấy chục case, và máy phân việc sẽ dồn
        thêm cho đúng người đang bận nhất.
      */
      const list = [...(theoNguoi.get(p.id) ?? []), ...(theoNguoi.get(`name:${p.name.trim().toLowerCase()}`) ?? [])];
      const codes = p.departments.map((d) => d.code);
      const limit = wipLimitOf(p.id, codes, cfg);
      const overdue = list.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) === "BREACHED").length;
      const a = cfg.away[p.id];
      const dangNghi = isAway(p.id, cfg, now);
      return {
        userId: p.id,
        name: p.name,
        email: p.email,
        departments: codes,
        load: list.length,
        overdue,
        blocked: list.filter((i) => i.status === "BLOCKED").length,
        waiting: list.filter((i) => i.status === "WAITING").length,
        limit,
        free: Math.max(0, limit - list.length),
        over: Math.max(0, list.length - limit),
        away: dangNghi && a ? a : null,
        skills: cfg.skills[p.id] ?? [],
        // Quá tải = vượt trần HOẶC quá nửa việc đang cầm đã vỡ hạn (xem chú thích đầu tệp).
        overloaded: list.length > limit || (list.length >= 4 && overdue * 2 > list.length),
        nearFull: list.length <= limit && limit - list.length <= WIP_NEAR_FULL_SLOTS,
        money: sumMoney(list),
      } satisfies CapacityRow;
    })
    .sort((a, b) => Number(b.overloaded) - Number(a.overloaded) || b.overdue - a.overdue || b.load - a.load);
}

/** Ai còn nhận thêm được loại việc này, ngay bây giờ. Dùng chung bởi máy phân việc và giao diện. */
export function eligibleFor(source: string, rows: CapacityRow[], cfg: StaffingConfig): CapacityRow[] {
  return rows.filter((r) => !r.away && r.free > 0 && handlesSource(r.userId, source, cfg));
}

export async function getCapacity(openItems: WorkItem[], now: Date, department?: DepartmentCode | null): Promise<{ rows: CapacityRow[]; cfg: StaffingConfig; people: OrgPerson[] }> {
  const [people, cfg] = await Promise.all([listOrgPeople(), getStaffing()]);
  return { rows: buildCapacity(people, openItems, cfg, now, department), cfg, people };
}
