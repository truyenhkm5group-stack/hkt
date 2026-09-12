import { DEPARTMENT_CODES, type DepartmentCode } from "@/lib/constants/departments";
import { WORK_SOURCES, WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";

/**
 * ═══════════ SỔ NHÂN LỰC: SỨC CHỨA · KỸ NĂNG · CÓ MẶT ═══════════
 *
 * Máy phân việc cần ba thứ mà CSDL nghiệp vụ không biết và không thể suy ra:
 *
 *  1. **Một người cầm được bao nhiêu việc** — không đọc được từ đâu cả. Phải có người khai.
 *  2. **Ai làm được loại việc gì** — `users.role` nói QUYỀN XEM, không nói tay nghề.
 *  3. **Hôm nay ai vắng** — nghỉ phép, đi công tác, ốm. Không hệ thống nào trong ERP biết.
 *
 * Ba thứ đó ở đây, lưu ở `settings` khoá `work.staffing`, sửa trên màn hình cấu hình.
 *
 * ─── VÌ SAO TỰ PHÂN VIỆC MẶC ĐỊNH TẮT ───
 *
 * Đo trên production 12/09/2026: **783 việc đang mở, 695 việc chưa ai nhận, và 1/7 người có phòng
 * ban.** Một job tự phân việc bật sẵn sẽ dồn toàn bộ phần việc của một phòng lên đúng người duy
 * nhất có tên trong phòng đó, ngay ở nhịp chạy đầu tiên. Người đó mở máy lên thấy vài trăm việc
 * mang tên mình — và từ lúc đó con số quá hạn của họ là con số của cả phòng.
 *
 * Nên: phân việc tự động là một NÚT chủ shop bấm (có xem trước), cộng một công tắc bật riêng cho
 * từng phòng. Mặc định tắt hết. Leo thang SLA thì ngược lại — mặc định BẬT, vì nó chỉ nâng mức ưu
 * tiên của việc đã vỡ hạn chứ không đổi chủ của việc nào.
 *
 * ─── TRẦN VIỆC KHÔNG PHẢI ĐỂ CHẶN NGƯỜI, MÀ ĐỂ LỘ RA THIẾU NGƯỜI ───
 *
 * Khi hết người còn chỗ, máy KHÔNG nhồi thêm. Phần việc còn lại nằm nguyên ở hàng đợi phòng và
 * được báo là "thiếu chỗ chứa" kèm con số. Nhồi cho hết là biến một vấn đề nhân sự nhìn thấy được
 * thành một danh sách cá nhân không ai làm nổi — và làm hỏng luôn mọi thước đo của người đó.
 */

export const WORK_STAFFING_KEY = "work.staffing";

/**
 * TRẦN VIỆC ĐANG CẦM MẶC ĐỊNH — 20.
 *
 * Không có con số nào đọc được từ dữ liệu shop cho tới khi người ta dùng hàng đợi một thời gian
 * (hiện `work_item_events` còn rỗng, chưa ai từng đóng việc qua `/work`). Nên đây là một mặc định
 * KHAI BÁO, không phải một phép đo, và nó được chọn theo đúng công dụng của nó: quá 20 việc đang
 * cầm thì danh sách thôi là danh sách việc và bắt đầu là một đống tồn đọng — người ta ngừng đọc nó.
 *
 * Chủ shop đổi được cho từng phòng và từng người. Khi có đủ dữ liệu đóng việc thật, con số này nên
 * được thay bằng số đo (thời gian xử lý trung vị × số giờ làm việc) — ghi vào việc còn phải làm.
 */
export const DEFAULT_WIP_LIMIT = 20;
export const WIP_MIN = 1;
export const WIP_MAX = 500;

/** Còn dưới ngần này chỗ trống thì coi là SẮP ĐẦY — giao diện đánh dấu vàng. */
export const WIP_NEAR_FULL_SLOTS = 3;

export type AwayEntry = { until: string; reason: string };

export type StaffingConfig = {
  /** Trần việc đang cầm theo phòng. Thiếu ⇒ `DEFAULT_WIP_LIMIT`. */
  departmentWip: Partial<Record<DepartmentCode, number>>;
  /** Trần riêng của một người — THẮNG trần phòng. Khoá là `users.id`. */
  userWip: Record<string, number>;
  /**
   * Loại việc một người nhận được khi máy phân.
   *
   * Danh sách RỖNG hoặc thiếu khoá = **nhận mọi loại việc của phòng mình**. Đó là mặc định đúng ở
   * shop nhỏ: ai cũng làm mọi việc của phòng, và bắt khai kỹ năng trước khi dùng được máy phân
   * việc là dựng một hàng rào không cần thiết. Khai kỹ năng chỉ để THU HẸP, không bao giờ để mở
   * rộng sang phòng khác.
   */
  skills: Record<string, WorkSource[]>;
  /** Nghỉ tới hết ngày nào (ISO). Người đang nghỉ KHÔNG được máy phân việc cho. */
  away: Record<string, AwayEntry>;
  /** Bật máy phân việc tự động cho phòng nào. MẶC ĐỊNH TẮT — xem chú thích đầu tệp. */
  autoAssign: Partial<Record<DepartmentCode, boolean>>;
  /** Tắt leo thang SLA cho phòng nào. Mặc định BẬT ở mọi phòng. */
  escalationOff: Partial<Record<DepartmentCode, boolean>>;
};

export const EMPTY_STAFFING: StaffingConfig = {
  departmentWip: {},
  userWip: {},
  skills: {},
  away: {},
  autoAssign: {},
  escalationOff: {},
};

/** Trần của một người: trần riêng → trần phòng → mặc định. */
export function wipLimitOf(userId: string, departments: DepartmentCode[], cfg: StaffingConfig): number {
  const rieng = cfg.userWip[userId];
  if (typeof rieng === "number" && Number.isFinite(rieng)) return rieng;
  /*
    Người ở NHIỀU phòng lấy trần CAO NHẤT trong các phòng của họ, không cộng dồn.
    Cộng dồn thì người kiêm ba phòng bỗng nhiên gánh được gấp ba — mà họ vẫn chỉ có một ngày làm
    việc. Lấy cao nhất là thừa nhận họ linh hoạt hơn, không phải rảnh gấp ba.
  */
  const theoPhong = departments.map((d) => cfg.departmentWip[d]).filter((n): n is number => typeof n === "number");
  return theoPhong.length ? Math.max(...theoPhong) : DEFAULT_WIP_LIMIT;
}

/** Người này có nhận loại việc đó không. Chưa khai kỹ năng = nhận tất. */
export function handlesSource(userId: string, source: string, cfg: StaffingConfig): boolean {
  const ds = cfg.skills[userId];
  if (!ds || ds.length === 0) return true;
  return ds.includes(source as WorkSource);
}

/** Đang nghỉ tới hết ngày đã khai. So theo MỐC, không so theo chuỗi ngày. */
export function isAway(userId: string, cfg: StaffingConfig, now: Date): boolean {
  const a = cfg.away[userId];
  if (!a) return false;
  const den = new Date(a.until);
  return !Number.isNaN(den.getTime()) && den.getTime() >= now.getTime();
}

export function autoAssignOn(department: DepartmentCode, cfg: StaffingConfig): boolean {
  return cfg.autoAssign[department] === true;
}

export function escalationOn(department: DepartmentCode, cfg: StaffingConfig): boolean {
  return cfg.escalationOff[department] !== true;
}

/**
 * ═══════════ LEO THANG: BA MỨC, VÀ MỖI MỨC LÀM ĐÚNG MỘT VIỆC ═══════════
 *
 * Leo thang KHÔNG được tạo ra việc mới, không đổi trạng thái nghiệp vụ, và không tự gán người.
 * Nó chỉ đổi **thứ tự đọc** và **ai nhìn thấy**:
 *
 *  · `WARN`    — còn dưới `warnHours` giờ là tới hạn. Nâng lên `HIGH` nếu đang thấp hơn.
 *  · `BREACH`  — đã vỡ hạn. Nâng lên `URGENT`.
 *  · `STALE`   — vỡ hạn quá `leadHours` giờ mà vẫn chưa ai nhận. Nâng `URGENT` VÀ nêu tên ở màn
 *                hình trưởng phòng như việc cần can thiệp.
 *
 * Không có mức nào tự giao việc cho trưởng phòng: một việc mang tên trưởng phòng là một việc đã
 * rời khỏi hàng đợi chung, và trưởng phòng thì không có thời gian làm việc của cả phòng.
 */
export const ESCALATION_WARN_HOURS = 4;
export const ESCALATION_LEAD_HOURS = 24;

export type EscalationLevel = "WARN" | "BREACH" | "STALE";

export const ESCALATION_LABEL: Record<EscalationLevel, string> = {
  WARN: "Sắp vỡ hạn",
  BREACH: "Đã vỡ hạn",
  STALE: "Vỡ hạn lâu, chưa ai nhận",
};

export const ESCALATION_WHY: Record<EscalationLevel, string> = {
  WARN: `Còn dưới ${ESCALATION_WARN_HOURS} giờ là tới hạn — nâng mức ưu tiên để nó nổi lên trước khi vỡ, không phải sau.`,
  BREACH: "Đã quá hạn: nâng lên Gấp. Việc quá hạn nằm lẫn giữa việc bình thường là việc sẽ tiếp tục bị bỏ qua.",
  STALE: `Vỡ hạn hơn ${ESCALATION_LEAD_HOURS} giờ mà vẫn chưa ai cầm — đây không còn là việc chậm, đây là việc KHÔNG AI LÀM. Trưởng phòng phải thấy tên nó.`,
};

/* ═══════════════════ LÁ CHẮN KHAI BÁO ═══════════════════ */

/** Mọi nguồn việc phải khai được trong ô chọn kỹ năng. Kiểm ở `tests/workforce.test.ts`. */
export const SKILL_SOURCES: WorkSource[] = [...WORK_SOURCES];

/** Nguồn việc ↔ phòng mặc định, để ô chọn kỹ năng chỉ gợi ý loại việc phòng đó thật sự nhận. */
export function sourcesOfDepartment(department: DepartmentCode, ownershipDepartmentOf: (s: WorkSource) => DepartmentCode | null): WorkSource[] {
  return WORK_SOURCES.filter((s) => {
    const d = ownershipDepartmentOf(s);
    // Nguồn không có phòng cố định (việc tay, việc định kỳ, cảnh báo) thuộc về mọi phòng.
    return d === null || d === department || WORK_SOURCE_SPEC[s].department === null;
  });
}

export const DEPARTMENTS_FOR_STAFFING: DepartmentCode[] = [...DEPARTMENT_CODES];
