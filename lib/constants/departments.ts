import { TEAM_ORDER, type CaseTeam } from "@/lib/constants/action-queue";

/**
 * ═══════════ PHÒNG BAN — TẦNG TỔ CHỨC MÀ ERP CHƯA TỪNG CÓ ═══════════
 *
 * Trước bản này, thứ gần nhất với "ai chịu trách nhiệm" là hai thứ KHÁC NHAU bị dùng lẫn:
 *
 *  · `users.role` — một VAI TRÒ PHÂN QUYỀN (được xem gì), không phải một chỗ đứng trong tổ chức.
 *    Hai người cùng vai `MANAGER` có thể phụ trách hai mảng chẳng liên quan gì nhau.
 *  · `CaseTeam` (`lib/constants/action-queue.ts`) — một NHÓM CÔNG VIỆC suy từ LOẠI việc.
 *
 * Cả hai đều không trả lời được "phòng nào đang kẹt" vì cả hai đều không có DANH SÁCH NGƯỜI.
 *
 * ─── VÌ SAO KHÔNG BỎ `CaseTeam` ĐI ───
 *
 * Hai khái niệm trả lời hai câu hỏi khác nhau và cả hai đều cần:
 *
 *   CaseTeam  = "việc này thuộc loại công việc nào"   (suy được từ bản thân việc)
 *   Phòng ban = "ai trong tổ chức chịu trách nhiệm"   (do chủ shop xếp, đổi được)
 *
 * Ở shop nhỏ một người gánh nhiều nhóm việc. Nếu ép hai khái niệm làm một thì mỗi lần chủ shop đổi
 * phân công lại phải sửa code. Nên: `CaseTeam` giữ nguyên, `TEAM_DEPARTMENT` là ánh xạ MẶC ĐỊNH, và
 * bảng `departments` trong CSDL là nơi đổi.
 */

export const DEPARTMENT_CODES = ["MANAGEMENT", "MARKETING", "SALES", "LOGISTICS", "WAREHOUSE", "FINANCE", "HR"] as const;
export type DepartmentCode = (typeof DEPARTMENT_CODES)[number];

export const DEPARTMENT_LABEL: Record<DepartmentCode, string> = {
  MANAGEMENT: "Ban điều hành",
  MARKETING: "Marketing",
  SALES: "Kinh doanh & CSKH",
  LOGISTICS: "Giao vận",
  WAREHOUSE: "Kho",
  FINANCE: "Kế toán",
  HR: "Nhân sự",
};

export const DEPARTMENT_HINT: Record<DepartmentCode, string> = {
  MANAGEMENT: "Chủ shop và quản lý: nhìn chéo phòng ban, chốt mục tiêu, gỡ nút thắt",
  MARKETING: "Quảng cáo, nội dung, ý tưởng, hiệu quả chi tiêu",
  SALES: "Chốt đơn từ tin nhắn, chăm khách, xử lý case CSKH, bán chéo",
  LOGISTICS: "Vận đơn, care kiện hàng, làm việc với Viettel Post",
  WAREHOUSE: "Đóng gói, xuất hàng, kiểm đếm hàng hoàn, tồn kho, đặt sản xuất",
  FINANCE: "Dòng tiền, đối soát COD, chi phí, lương, sổ ngân hàng",
  HR: "Tuyển dụng, đào tạo, chấm công, đánh giá",
};

/** Thứ tự hiển thị: phòng có khách đang chờ đứng trước phòng việc nội bộ. */
export const DEPARTMENT_ORDER: DepartmentCode[] = ["SALES", "LOGISTICS", "WAREHOUSE", "MARKETING", "FINANCE", "MANAGEMENT", "HR"];

export const DEPARTMENT_TONE: Record<DepartmentCode, string> = {
  MANAGEMENT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  MARKETING: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  SALES: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  LOGISTICS: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  WAREHOUSE: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  FINANCE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  HR: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
};

/**
 * Nhóm công việc → phòng ban. MẶC ĐỊNH lúc cài đặt, không phải chân lý.
 *
 * `DATA` → `MANAGEMENT` cố ý: số liệu sai không thuộc phòng nào cụ thể, nó chặn quyết định của
 * mọi phòng. Để nó ở một phòng vận hành thì nó luôn bị xếp sau việc có khách đang chờ.
 *
 * `PRODUCTION` → `WAREHOUSE`: ở shop này người quyết đặt bao nhiêu hàng chính là người giữ kho.
 * Tách ra thành phòng riêng khi nào có người chuyên trách.
 */
export const TEAM_DEPARTMENT: Record<CaseTeam, DepartmentCode> = {
  CS: "SALES",
  LOGISTICS: "LOGISTICS",
  WAREHOUSE: "WAREHOUSE",
  PRODUCTION: "WAREHOUSE",
  FINANCE: "FINANCE",
  ADS: "MARKETING",
  DATA: "MANAGEMENT",
};

export function departmentOfTeam(team: CaseTeam): DepartmentCode {
  return TEAM_DEPARTMENT[team];
}

/** Vai trò phân quyền → phòng ban gợi ý khi khởi tạo thành viên lần đầu. Chỉ là GỢI Ý. */
export const ROLE_DEPARTMENT_HINT: Record<string, DepartmentCode> = {
  ADMIN: "MANAGEMENT",
  MANAGER: "MANAGEMENT",
  LEADER: "SALES",
  ACCOUNTANT: "FINANCE",
  WAREHOUSE: "WAREHOUSE",
  CS: "SALES",
  MARKETING: "MARKETING",
};

/** Vai trong phòng. Trưởng phòng thấy toàn bộ việc của phòng; thành viên thấy việc của mình. */
export const DEPARTMENT_ROLES = ["LEAD", "MEMBER"] as const;
export type DepartmentRole = (typeof DEPARTMENT_ROLES)[number];

export const DEPARTMENT_ROLE_LABEL: Record<DepartmentRole, string> = {
  LEAD: "Trưởng phòng",
  MEMBER: "Thành viên",
};

/** Lá chắn khai báo: mọi nhóm việc phải có phòng ban. Kiểm ở `tests/work-os.test.ts`. */
export const TEAMS_WITHOUT_DEPARTMENT = TEAM_ORDER.filter((t) => !TEAM_DEPARTMENT[t]);
