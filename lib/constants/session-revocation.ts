/**
 * ═══════════ THU HỒI PHIÊN: LUẬT Ở MỘT CHỖ ═══════════
 *
 * Tệp này KHÔNG import gì — cùng lý do với `lib/constants/session.ts`: nó phải nạp được từ server
 * action, từ truy vấn, từ client component và từ bài kiểm mà không kéo theo CSDL.
 *
 * ─── MỘT CỘT, GRAIN LÀ CON NGƯỜI ───
 *
 * `users.session_invalid_before` trả lời đúng một câu: *"mọi phiên của người này bắt đầu TRƯỚC mốc
 * ấy đều không còn giá trị"*. Nó KHÔNG trả lời được "đăng xuất riêng cái điện thoại, giữ laptop" —
 * việc đó cần `jti` và một bảng phiên. Ghi rõ ra đây để sau này không ai tưởng nó làm được.
 *
 * ─── SO VỚI `lgn`, KHÔNG BAO GIỜ SO VỚI `iat` ───
 *
 * Gia hạn trượt ký lại token và đẩy `iat` lên ở mỗi lượt GET. So với `iat` thì lượt gia hạn kế
 * tiếp HỒI SINH đúng phiên vừa bị thu hồi — tính năng im lặng không hoạt động. `lgn` đi nguyên vẹn
 * qua mọi lần gia hạn nên nó là mốc duy nhất dùng được.
 */

/** Vì sao một phiên bị thu hồi. Đi vào `audit_logs.detail.trigger`. */
export type RevokeTrigger =
  /** Người dùng tự bấm "Đăng xuất mọi thiết bị". */
  | "SELF_LOGOUT_ALL"
  /** Quản trị thu hồi phiên của người khác — BẮT BUỘC có lý do. */
  | "ADMIN_REVOKE"
  /** Đổi mật khẩu (tự đổi) hoặc quản trị đặt lại mật khẩu. */
  | "PASSWORD_RESET"
  /** Khoá tài khoản. */
  | "ACCOUNT_DISABLED";

export const REVOKE_TRIGGER_LABEL: Record<RevokeTrigger, string> = {
  SELF_LOGOUT_ALL: "Tự đăng xuất mọi thiết bị",
  ADMIN_REVOKE: "Quản trị thu hồi phiên",
  PASSWORD_RESET: "Đổi / đặt lại mật khẩu",
  ACCOUNT_DISABLED: "Khoá tài khoản",
};

/**
 * Những lượt thu hồi BẮT BUỘC kèm lý do.
 *
 * Chỉ `ADMIN_REVOKE`: ba cái kia tự nó đã nói lý do (người dùng tự bấm · mật khẩu vừa đổi · tài
 * khoản vừa bị khoá). Còn "quản trị đá một người ra khỏi hệ thống" mà không ghi vì sao thì ba
 * tháng sau không ai giải thích được, kể cả chính người đã bấm.
 */
export const REVOKE_NEEDS_REASON: readonly RevokeTrigger[] = ["ADMIN_REVOKE"];

export function revokeNeedsReason(trigger: RevokeTrigger) {
  return REVOKE_NEEDS_REASON.includes(trigger);
}

/** Hành động ghi vào `audit_logs.action` cho một lượt thu hồi. */
export const REVOKE_AUDIT_ACTION = "SESSION_REVOKE";

/**
 * Mốc thu hồi mới, tính từ "bây giờ": LÀM TRÒN LÊN tới giây kế tiếp.
 *
 * `lgn` trong token chỉ có độ phân giải GIÂY. Nếu mốc thu hồi giữ nguyên phần mili giây thì một
 * lần đăng nhập xảy ra SAU lượt thu hồi nhưng trong CÙNG một giây sẽ có `lgn` bằng đầu giây ấy —
 * và hai phía không phân biệt được. Làm tròn LÊN biến sự mơ hồ đó thành một hướng DUY NHẤT và an
 * toàn: mọi phiên của giây đang diễn ra đều chết, mọi lần đăng nhập từ giây kế tiếp đều sống.
 *
 * Cái giá tối đa: người vừa bị thu hồi mà đăng nhập lại trong cùng một giây phải bấm lại một lần.
 * Chiều ngược lại — để lọt một phiên đáng lẽ đã chết — là thứ không được phép đánh đổi.
 */
export function revokeMarkFrom(nowMs: number): number {
  return Math.ceil(nowMs / 1000) * 1000;
}

/**
 * Phiên này có bị thu hồi không?
 *
 * @param loginAtSec  mốc đăng nhập GỐC lấy từ token (`lgn`, đơn vị GIÂY)
 * @param invalidBefore  `users.session_invalid_before` — `null` = CHƯA TỪNG THU HỒI, không phải
 *                       "thu hồi từ năm 1970"
 */
export function sessionRevoked(loginAtSec: number | null | undefined, invalidBefore: Date | null | undefined): boolean {
  if (!invalidBefore) return false;
  // Token không khai được mốc đăng nhập mà tài khoản ĐÃ từng bị thu hồi ⇒ không chứng minh được nó
  // sinh ra sau lượt thu hồi ⇒ từ chối. Nhánh này chỉ chạm tới token dị dạng; token thường luôn có
  // `lgn`, và token trước bản gia hạn trượt thì `claimsFrom()` lùi về `iat` (cũng đúng là mốc đăng
  // nhập của chúng).
  if (typeof loginAtSec !== "number" || !Number.isFinite(loginAtSec)) return true;
  return loginAtSec * 1000 < invalidBefore.getTime();
}

/**
 * VÌ SAO một lượt gọi bị từ chối. Mỗi nguyên nhân một câu khác nhau.
 *
 * Trước bản này cả ba đều ra `/login?reason=inactive` — tức là **nói với nhân viên rằng tài khoản
 * họ bị khoá trong khi tài khoản hoàn toàn bình thường**, và họ đi gọi quản trị.
 */
export type SessionDenyReason =
  | "NOT_FOUND"
  | "DISABLED"
  | "REVOKED"
  /**
   * Phiên thuộc một tổ chức không còn hoạt động (đình chỉ / lưu trữ) hoặc không còn tồn tại
   * (docs/platform/shared-contracts.md mục 3). KHÔNG rơi về tổ chức nhà — rơi về nhà là cho người
   * của tổ chức B đọc CSDL của A.
   */
  | "ORG_INACTIVE"
  /**
   * Đường dẫn đang mở thuộc một module tổ chức CHƯA BẬT (target-architecture P8, P9). Người dùng và
   * phiên đều hợp lệ — chỉ trang này không dùng được, nên nó KHÔNG đưa về `/login` mà về
   * `/module-disabled?m=<khoá>`. Tham số dưới đây chỉ để câu hiển thị có mặt nếu nó lọt tới `/login`.
   */
  | "MODULE_DISABLED"
  /**
   * Host đang mở là tên miền con của MỘT tổ chức (0180) mà phiên thuộc tổ chức KHÁC — hoặc tên miền con không trỏ tới ERP
   * đã xuất bản nào. Không chọn bên nào: đăng nhập lại bằng tài khoản của ERP ở địa chỉ này.
   */
  | "HOST_MISMATCH"
  /**
   * Tổ chức quá hạn thanh toán và hết ân hạn (0187, `lib/billing/rules.ts`) — CHỈ XEM: mọi lượt ĐỌC vẫn đi, lượt GHI bị
   * từ chối. Không đưa về `/login` (phiên hợp lệ) mà về `/billing-locked`, nơi nói ai trả được và trả ở đâu.
   */
  | "BILLING_LOCKED";

/** Tham số `?reason=` trên `/login` cho từng nguyên nhân. */
export const DENY_REASON_PARAM: Record<SessionDenyReason, string> = {
  NOT_FOUND: "invalid",
  DISABLED: "inactive",
  REVOKED: "revoked",
  ORG_INACTIVE: "org-inactive",
  MODULE_DISABLED: "module-disabled",
  HOST_MISMATCH: "host-mismatch",
  BILLING_LOCKED: "billing-locked",
};

/** Trang giải thích "module chưa bật" — `requireUser()` chuyển tới đây kèm `?m=<khoá module>`. */
export const MODULE_DISABLED_PATH = "/module-disabled";

/** Trang giải thích "tổ chức đang chỉ xem vì quá hạn thanh toán" — `requireUser()` chuyển tới đây (0187). */
export const BILLING_LOCKED_PATH = "/billing-locked";

/** Lý do KHÔNG phải một lượt từ chối: người dùng vừa tự đổi mật khẩu và được đưa về đây. */
export const REASON_PASSWORD_CHANGED = "password-changed";

export const DENY_REASON_MESSAGE: Record<string, string> = {
  invalid: "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.",
  inactive: "Tài khoản đã bị khoá. Liên hệ quản trị viên.",
  revoked: "Phiên đăng nhập đã bị thu hồi. Vui lòng đăng nhập lại.",
  "org-inactive": "Tổ chức của phiên đăng nhập này đang tạm ngừng hoặc không còn tồn tại. Liên hệ quản trị viên của tổ chức.",
  "module-disabled": "Chức năng này chưa được bật cho tổ chức của bạn. Liên hệ quản trị viên của tổ chức.",
  "host-mismatch": "Phiên đăng nhập này thuộc một ERP khác địa chỉ đang mở. Đăng nhập bằng tài khoản của ERP ở địa chỉ này.",
  "billing-locked": "Tổ chức đang ở chế độ chỉ xem vì quá hạn thanh toán. Quản trị của tổ chức gia hạn ở Hệ thống → Gói & thanh toán.",
  // KHÔNG dùng chung câu "đã bị thu hồi": người vừa tự bấm đổi mật khẩu mà đọc câu ấy sẽ tưởng
  // mình bị quản trị đá ra. Cùng một cơ chế, hai tình huống, hai câu.
  [REASON_PASSWORD_CHANGED]: "Đã đổi mật khẩu. Hãy đăng nhập lại bằng mật khẩu mới.",
};

/**
 * Những `?reason=` mà trang `/login` KHÔNG được tự chuyển hướng người dùng đi.
 *
 * ĐÂY LÀ MỘT CÁI BẪY CÓ THẬT, không phải phòng xa. `/login` gọi `getSession()` — hàm này chỉ kiểm
 * CHỮ KÝ và HẠN, nó không biết gì về CSDL. Một phiên bị thu hồi vẫn có cookie ký đúng và còn hạn,
 * nên `getSession()` trả về một phiên hợp lệ. Nếu `/login` thấy "có phiên" rồi đẩy người dùng về
 * trang trong, trang đó gọi `requireUser()` → bị từ chối → đẩy ngược ra `/login` → **vòng lặp vô
 * tận**. Mọi nguyên nhân từ chối phải nằm trong danh sách này.
 */
export const LOGIN_REASONS_STAY: readonly string[] = ["invalid", "inactive", "revoked", "org-inactive", "module-disabled", "host-mismatch", "billing-locked", REASON_PASSWORD_CHANGED];

export function loginShouldStay(reason: string | undefined): boolean {
  return !!reason && LOGIN_REASONS_STAY.includes(reason);
}
