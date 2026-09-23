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

export const DEPARTMENT_CODES = ["MANAGEMENT", "MARKETING", "SALES", "LOGISTICS", "WAREHOUSE", "PRODUCTION", "FINANCE", "HR"] as const;
export type DepartmentCode = (typeof DEPARTMENT_CODES)[number];

export const DEPARTMENT_LABEL: Record<DepartmentCode, string> = {
  MANAGEMENT: "Ban điều hành",
  MARKETING: "Marketing",
  SALES: "Kinh doanh & CSKH",
  LOGISTICS: "Giao vận",
  WAREHOUSE: "Kho",
  PRODUCTION: "Sản xuất",
  FINANCE: "Kế toán",
  HR: "Nhân sự",
};

export const DEPARTMENT_HINT: Record<DepartmentCode, string> = {
  MANAGEMENT: "Chủ shop và quản lý: nhìn chéo phòng ban, chốt mục tiêu, gỡ nút thắt",
  MARKETING: "Quảng cáo, nội dung, ý tưởng, hiệu quả chi tiêu",
  SALES: "Chốt đơn từ tin nhắn, chăm khách, xử lý case CSKH, bán chéo",
  LOGISTICS: "Vận đơn, care kiện hàng, làm việc với Viettel Post",
  WAREHOUSE: "Đóng gói, xuất hàng, kiểm đếm hàng hoàn, tồn kho",
  PRODUCTION: "Kế hoạch đặt hàng, làm việc với xưởng, quyết định bỏ vốn vào mẫu nào",
  FINANCE: "Dòng tiền, đối soát COD, chi phí, lương, sổ ngân hàng",
  HR: "Tuyển dụng, đào tạo, chấm công, đánh giá",
};

/** Thứ tự hiển thị: phòng có khách đang chờ đứng trước phòng việc nội bộ. */
export const DEPARTMENT_ORDER: DepartmentCode[] = ["SALES", "MARKETING", "LOGISTICS", "WAREHOUSE", "PRODUCTION", "FINANCE", "MANAGEMENT", "HR"];

export const DEPARTMENT_TONE: Record<DepartmentCode, string> = {
  MANAGEMENT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  MARKETING: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  SALES: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  LOGISTICS: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  WAREHOUSE: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  PRODUCTION: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  FINANCE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  HR: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
};

/**
 * Nhóm công việc → phòng ban. MẶC ĐỊNH lúc cài đặt, không phải chân lý.
 *
 * `DATA` → `MANAGEMENT` cố ý: số liệu sai không thuộc phòng nào cụ thể, nó chặn quyết định của
 * mọi phòng. Để nó ở một phòng vận hành thì nó luôn bị xếp sau việc có khách đang chờ.
 *
 * ─── `PRODUCTION` → `WAREHOUSE`: BẢN ĐỒ MÀN HÌNH ĐÃ TÁCH, HÀNG ĐỢI VIỆC THÌ CHƯA ───
 *
 * Từ 23/09/2026 phòng `PRODUCTION` có thật trong sổ này và SỞ HỮU ba màn hình đặt hàng sản xuất
 * (`lib/constants/department-modules.ts`). Nhưng ánh xạ NHÓM VIỆC dưới đây CỐ Ý vẫn trỏ về `WAREHOUSE`,
 * và đó là quyết định của chủ shop khi tách phòng, không phải một chỗ quên sửa:
 *
 *   Một phòng CHƯA CÓ THÀNH VIÊN mà đã nhận việc thì việc rơi vào hàng đợi không ai mở — tệ hơn hẳn
 *   "chưa ai nhận" ở một phòng có người, vì trên màn hình nó đã "có chủ". Đúng lớp lỗi mà đầu tệp
 *   `lib/constants/work-ownership.ts` mô tả, chỉ ở mức phòng ban thay vì mức cá nhân.
 *
 * Nên thứ tự bắt buộc là: xếp người vào phòng Sản xuất TRƯỚC, rồi mới chuyển việc sang. Và lúc
 * chuyển thì KHÔNG CẦN DEPLOY — ghi đè ở `settings` khoá `work.ownership` (Công việc → Cấu hình →
 * Phòng chịu trách nhiệm) đã đủ, vì `departmentFor()` đọc ghi đè trước mặc định.
 *
 * `TEAM_DEPARTMENT_DIVERGENCE` khai tường minh chỗ lệch này để không ai "sửa hộ" nó trong một lượt
 * dọn dẹp — `tests/department-map.test.ts` đọc bảng đó và đòi mỗi dòng phải có lý do.
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

/**
 * CHỖ LỆCH CỐ Ý giữa phòng ban SỞ HỮU MÀN HÌNH và phòng ban NHẬN VIỆC — mỗi dòng kèm lý do.
 *
 * Bảng này không tham gia phép tính nào. Nó tồn tại để câu hỏi *"vì sao màn hình đặt hàng thuộc
 * phòng Sản xuất mà việc tồn kho lại về phòng Kho?"* có một câu trả lời đọc được ngay trong mã
 * nguồn, thay vì trông như một lỗi và bị ai đó "sửa" mất.
 */
export const TEAM_DEPARTMENT_DIVERGENCE: { team: CaseTeam; routedTo: DepartmentCode; modulesOwnedBy: DepartmentCode; why: string }[] = [
  {
    team: "PRODUCTION",
    routedTo: "WAREHOUSE",
    modulesOwnedBy: "PRODUCTION",
    why: "Phòng Sản xuất mới tách (23/09/2026) và chưa có thành viên. Việc giao cho một phòng trống là việc không ai mở, nên hàng đợi ở lại phòng Kho tới khi chủ shop xếp người — đổi bằng ghi đè `work.ownership`, không cần deploy.",
  },
];

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
