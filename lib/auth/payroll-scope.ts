/**
 * ═══════════ PHẠM VI XEM LƯƠNG: MỘT CHỖ QUYẾT, TRƯỚC KHI CHẠM DỮ LIỆU ═══════════
 *
 * ─── SỰ CỐ TỆP NÀY SINH RA ĐỂ CHẶN ───
 *
 * Đo trên production 15/09/2026: bảng `settings` có khoá `auth.rolePermissions`, và mảng của vai
 * trò `MANAGER` trong đó CHỨA `payroll:view`.
 *
 * `rolePermissions()` (`lib/auth/permissions.ts`) đọc mẫu vai trò bằng phép **THAY THẾ**, không
 * hợp nhất: có mảng lưu thì mảng ấy LÀ quyền của vai trò, mặc định trong mã không được hỏi tới.
 * Nên bản vá quyền viết trong mã nguồn **không** với tới được cấu hình ấy — mã nói TỪ CHỐI, dữ
 * liệu nói CHO PHÉP, và dữ liệu thắng.
 *
 * Bài học: **một bản vá quyền chỉ sửa mặc định trong mã là một bản vá báo cáo mình đã xong trong
 * khi chưa.** An toàn không được phụ thuộc vào việc ai đó nhớ đi dọn cấu hình cũ.
 *
 * ─── NÊN QUYỀN XEM TOÀN CÔNG TY PHẢI ĐƯỢC CẤP TƯỜNG MINH ───
 *
 * `payroll:view-all` là khoá DUY NHẤT mở ra bảng lương của người khác. Nó MỚI, nên không cấu hình
 * cũ nào đang mang nó — đó chính là điều khiến nó an toàn trước một bản ghi đè lỗi thời.
 *
 * `payroll:view` (khoá cũ, nhãn "xem toàn bộ") từ nay **KHÔNG còn tự nó nghĩa là xem tất cả**. Nó
 * rơi về SELF. Mất quyền xem là phiền; lộ bảng lương toàn công ty cho một chức danh chưa từng
 * được ai quyết định cấp thì không sửa lại được — AGENTS.md mục 31: mọi nhánh lỗi phải rơi về phía
 * HẸP HƠN.
 *
 * ─── VÌ SAO KHÔNG KIỂM BẰNG TÊN VAI TRÒ ───
 *
 * Viết `if (role === "MANAGER") return false` rải rác ở màn hình là sửa đúng MỘT đường vào, trong
 * khi số đường vào chỉ có tăng: trang, API xuất tệp, phiếu lương, lịch sử kỳ. Tên vai trò cũng là
 * một cái nhãn đổi được, và AGENTS.md mục 29 đã cấm nối nhãn vào quyền. Ở đây quyết định đi bằng
 * KHOÁ QUYỀN, tính MỘT LẦN, ở máy chủ, **trước** khi đọc dòng dữ liệu nào.
 *
 * ─── BỐN MỨC, VÀ `TEAM` CHƯA ĐƯỢC XÂY ───
 *
 * `TEAM` có tên ở đây để nó là một mức PHẢI XỬ LÝ chứ không phải một chỗ trống người sau tự điền.
 * ERP hôm nay **chưa** đo được "nhóm của một người" ở mức đủ tin để cắt tiền lương theo, nên
 * `TEAM` ⇒ **TỪ CHỐI**, không bao giờ được nâng thành `ALL`. Ngày có phạm vi nhóm thật, chỗ phải
 * sửa là đúng một hàm dưới đây.
 */

import { hasPermission } from "@/lib/auth/permissions";

/** Bốn mức, theo thứ tự rộng dần. `TEAM` khai ra để buộc phải xử lý, chưa dùng — xem đầu tệp. */
export const PAYROLL_SCOPES = ["NONE", "SELF", "TEAM", "ALL"] as const;
export type PayrollScope = (typeof PAYROLL_SCOPES)[number];

/**
 * Phạm vi nhóm CHƯA ĐƯỢC XÂY. Hằng số này tồn tại để câu "chưa làm" nằm trong mã nguồn chứ không
 * chỉ nằm trong một tài liệu, và để bài kiểm bám vào được.
 */
export const TEAM_SCOPE_NOT_IMPLEMENTED = true as const;

export const PAYROLL_SCOPE_LABEL: Record<PayrollScope, string> = {
  NONE: "Không xem được bảng lương",
  SELF: "Chỉ lương của chính mình",
  TEAM: "Nhóm mình (CHƯA XÂY — đang từ chối)",
  ALL: "Toàn công ty",
};

/** Người dùng tối thiểu cần gì để tính được phạm vi. Cố ý KHÔNG nhận tên vai trò. */
export type PayrollScopeSubject = {
  role?: string | null;
  permissions?: readonly string[] | null;
};

/**
 * ═══ QUYẾT ĐỊNH DUY NHẤT ═══
 *
 * Thứ tự dưới đây là một quyết định, không phải tiện tay:
 *
 *  1. `ADMIN` đi trước vì `can()` cũng cho `ADMIN` mọi quyền — nếu chỗ này nói khác, hai máy tính
 *     quyền sẽ bất đồng và màn hình sẽ hiện một đằng, API trả một nẻo.
 *  2. `payroll:view-all` là đường DUY NHẤT tới `ALL`.
 *  3. `payroll:view` (khoá cũ) và `payroll:view-own` đều chỉ tới `SELF`. Khoá cũ được đọc tường
 *     minh ở đây thay vì trông vào `expandLegacy` — phòng đúng trường hợp một danh sách quyền đi
 *     tới nơi mà chưa qua lượt mở rộng.
 *  4. Còn lại là `NONE`. Không có nhánh nào rơi về `ALL`.
 */
export function resolvePayrollScope(user: PayrollScopeSubject | null | undefined): PayrollScope {
  if (!user) return "NONE";
  if (user.role === "ADMIN") return "ALL";
  const perms = user.permissions ?? null;
  if (hasPermission(perms, "payroll:view-all")) return "ALL";
  if (hasPermission(perms, "payroll:view-own") || hasPermission(perms, "payroll:view")) return "SELF";
  return "NONE";
}

/** Có được xem dòng của NGƯỜI KHÁC không. Chỉ `ALL`. `TEAM` chưa xây nên cũng là không. */
export function canSeeAllPayroll(scope: PayrollScope): boolean {
  return scope === "ALL";
}

/** Có mở được màn hình lương ở mức nào đó không (kể cả chỉ của mình). */
export function canOpenPayroll(scope: PayrollScope): boolean {
  return scope === "ALL" || scope === "SELF";
}

/**
 * ═══ MÀN HÌNH QUẢN TRỊ LƯƠNG: PHẢI CÓ CẢ HAI ═══
 *
 * `payroll:manage` một mình là KHÔNG ĐỦ, và đây là lỗ hổng thứ hai đo được trên production cùng
 * ngày: mảng ghi đè của `MANAGER` mang **cả** `payroll:view` **lẫn** `payroll:manage`.
 *
 * Năm màn hình quản trị (chính sách · phân công · điều chỉnh · nhập liệu · xem trước chuyển đổi)
 * không phải là "công cụ khai báo" — chúng IN RA TIỀN CỦA MỌI NGƯỜI. `/payroll/migration` chẳng
 * hạn dựng bảng đối chiếu lương cũ/mới cho TOÀN BỘ nhân sự. Nên nếu chỉ chặn `/payroll` mà để ngỏ
 * chúng, bản vá phạm vi bị đi vòng qua đúng một đường dẫn — và người đi vòng không cần biết gì về
 * kỹ thuật, chỉ cần bấm một mục trong thanh tab.
 *
 * Nên: quản trị lương = QUYỀN KHAI BÁO **VÀ** PHẠM VI TOÀN CÔNG TY. Ai không được phép NHÌN bảng
 * lương thì cũng không có việc gì phải sửa nó — một người quản trị lương mà không được xem lương
 * là một vai không có nghĩa.
 *
 * Nhận `manage` từ bên ngoài (kết quả của `can(user, "payroll:manage")`) để tệp này không phải
 * nhập `lib/auth/session.ts` — `can()` nằm cùng tầng và sẽ thành phụ thuộc vòng.
 */
export function canAdministerPayroll(user: PayrollScopeSubject | null | undefined, manage: boolean): boolean {
  if (!user) return false;
  if (user.role === "ADMIN") return true;
  return manage && canSeeAllPayroll(resolvePayrollScope(user));
}

/**
 * ═══ MỘT DÒNG CÓ ĐƯỢC HIỆN KHÔNG — CHỖ DUY NHẤT QUYẾT ĐỊNH ═══
 *
 * Mọi màn hình và mọi điểm cuối gọi đúng hàm này, nên "ẩn cái nút" không bao giờ bị nhầm thành
 * "chặn", và không nơi nào tự viết lại điều kiện `viewAll || khớp(...)`.
 *
 * `NONE` và `TEAM` trả `false`. Đó là điểm mấu chốt: một nhánh chưa xây phải ra KHÔNG THẤY GÌ, chứ
 * không được rơi xuống nhánh "cho hết" — `TEAM` nằm giữa `SELF` và `ALL` nên một câu `switch` viết
 * ẩu rất dễ cho nó đi chung đường với `ALL`.
 *
 * Nhận `matches` làm tham số thay vì tự gọi `employeeMatchesUser`, để tệp này KHÔNG kéo theo tầng
 * truy vấn (và do đó không kéo `@/db` vào bất cứ chỗ nào lỡ nhập nó).
 */
export function payrollLineVisible<E, U>(scope: PayrollScope, employee: E, user: U, matches: (employee: E, user: U) => boolean): boolean {
  if (scope === "ALL") return true;
  if (scope === "SELF") return matches(employee, user);
  return false;
}
