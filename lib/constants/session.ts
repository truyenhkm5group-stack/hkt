/**
 * ═══════════ PHIÊN ĐĂNG NHẬP: HAI ĐỒNG HỒ, KHÔNG GỘP ═══════════
 *
 * Tệp này là LUẬT PHIÊN, và nó cố ý KHÔNG import gì cả — không `lib/env`, không `db`, không
 * `next/*`. Lý do: `middleware.ts` chạy ở Edge và không nạp được mã chạy ở Node, nên luật phiên
 * trước đây bị chép ra hai chỗ (số ngày ở `lib/auth/session.ts`, phép kiểm ở middleware). Hai bản
 * chép là hai cách để chúng lệch nhau, và một bên nói "còn hạn" trong khi bên kia nói "hết hạn"
 * là cách chắc chắn nhất để người dùng bị đá ra mà không ai giải thích được.
 *
 * ─── VÌ SAO PHẢI CÓ TỆP NÀY (sự cố đo được 19/09/2026) ───
 *
 * Token ký cứng 7 ngày tính từ lúc đăng nhập và KHÔNG BAO GIỜ được gia hạn. Đúng 7 ngày sau,
 * giữa giờ làm, chuỗi sau đây chạy mà người dùng không chạm vào gì:
 *
 *   token hết hạn → `/api/events` trả 401 → SSE chết → `realtime-provider` cứ 5 phút gọi
 *   `router.refresh()` → middleware thấy token hỏng → chuyển hướng `/login`
 *
 * Tức là NGƯỜI DÙNG ĐANG LÀM VIỆC BỊ MỘT ĐỒNG HỒ NỀN ĐÁ RA. Không phải ngẫu nhiên, không phải
 * "mạng lag": nó xảy ra đúng 7 ngày sau mỗi lần đăng nhập, và mất luôn thứ họ đang gõ dở.
 *
 * ─── HAI ĐỒNG HỒ, VÀ VÌ SAO KHÔNG ĐƯỢC CHỈ CÓ MỘT ───
 *
 *  · `SESSION_IDLE_DAYS`     — ĐỒNG HỒ NGHỈ. Không dùng ERP bao lâu thì phải đăng nhập lại.
 *                              TRƯỢT: mỗi lần người dùng thật sự mở một trang, nó được đẩy lùi.
 *  · `SESSION_ABSOLUTE_DAYS` — ĐỒNG HỒ SỐNG. Tính từ lần ĐĂNG NHẬP GỐC và KHÔNG BAO GIỜ trượt.
 *
 * Chỉ có đồng hồ nghỉ ⇒ một cookie bị lấy cắp sống mãi: kẻ cầm nó chỉ cần gọi một trang mỗi tuần.
 * Chỉ có đồng hồ sống ⇒ đúng bệnh đang phải chữa. Phải có cả hai, và đồng hồ sống là TRẦN CỨNG:
 * người chăm chỉ nhất cũng phải đăng nhập lại sau `SESSION_ABSOLUTE_DAYS`.
 *
 * Hai con số này là QUYẾT ĐỊNH AN NINH của chủ shop, không phải hằng số kỹ thuật. Đổi ở ĐÂY và
 * chỉ ở đây; không gõ lại một con số ngày nào ở `middleware.ts` hay `lib/auth/session.ts`.
 */

/** Tên cookie phiên. Dùng chung cho cả Edge (middleware) lẫn Node (server action, route). */
export const SESSION_COOKIE = "erp_session";

/**
 * Không mở ERP bao nhiêu ngày thì phải đăng nhập lại. Giữ nguyên 7 ngày đang chạy — bản này KHÔNG
 * nới lỏng thời gian nghỉ, nó chỉ làm cho 7 ngày ấy đếm từ LẦN DÙNG CUỐI thay vì từ lần đăng nhập.
 */
export const SESSION_IDLE_DAYS = 7;

/**
 * TRẦN TUYỆT ĐỐI tính từ lần đăng nhập gốc. Dù dùng liên tục, sau ngần này ngày vẫn phải nhập lại
 * mật khẩu. Đây là thứ duy nhất chặn "phiên bất tử", và cũng là thứ chặn một cookie bị lấy cắp
 * sống quá lâu.
 *
 * 30 ngày: một tài khoản nội bộ đăng nhập lại mỗi tháng là nhịp chịu được cho người làm, còn cửa
 * sổ 30 ngày cho một cookie rò rỉ thì đủ hẹp để một lần đổi mật khẩu / khoá tài khoản kịp chặn —
 * khoá tài khoản có hiệu lực NGAY, không đợi trần này (xem `getCurrentUser`).
 */
export const SESSION_ABSOLUTE_DAYS = 30;

/**
 * Gia hạn khi token đã đi qua BAO NHIÊU phần đời của nó.
 *
 * Không gia hạn ở mọi lượt gọi: mỗi lần gia hạn là một lần ký lại + một `Set-Cookie` trên đường
 * truyền, mà bàn care gọi `/api/notifications` 30 giây một lần. Nửa đời nghĩa là mỗi token được
 * ký lại nhiều nhất vài lần trong đời nó, và người dùng vẫn còn trọn nửa sau làm biên an toàn nếu
 * một lượt gia hạn nào đó trượt (mạng hỏng, tab ngủ).
 */
export const SESSION_RENEW_AFTER_FRACTION = 0.5;

const NGAY = 86_400;

/** Claim mang mốc ĐĂNG NHẬP GỐC. Tách khỏi `iat` vì `iat` bị đẩy lên sau mỗi lần gia hạn. */
export const SESSION_LOGIN_CLAIM = "lgn";

/**
 * Phần của token mà luật phiên cần. Tất cả tính bằng GIÂY (đơn vị của JWT), không phải mili-giây —
 * trộn hai đơn vị ở đây là sai lệch 1000 lần, và nó sẽ trông như "ai cũng hết hạn ngay lập tức".
 */
export type SessionClaims = {
  issuedAtSec: number;
  expiresAtSec: number;
  /** Mốc đăng nhập gốc. Token cũ (trước bản này) không có claim đó ⇒ lấy `iat`, xem `claimsFrom`. */
  loginAtSec: number;
};

export type RenewalDecision =
  | {
      renew: false;
      /**
       * VÌ SAO KHÔNG GIA HẠN — bốn câu trả lời khác nhau, và gộp chúng thành `false` trơn là mất
       * đúng thứ cần để gỡ lỗi: "chưa tới lúc" khác hẳn "đã hết hạn" khác hẳn "đã kịch trần".
       */
      reason: "NO_TOKEN" | "EXPIRED" | "TOO_EARLY" | "AT_ABSOLUTE_CAP";
    }
  | { renew: true; expiresAtSec: number; loginAtSec: number };

/**
 * CÓ NÊN GIA HẠN TOKEN NÀY KHÔNG — hàm THUẦN, không đọc đồng hồ, không đọc CSDL, không đọc cookie.
 *
 * Nhận `nowSec` từ ngoài nên bài kiểm dựng được mọi mốc mà không phải ghim một ngày tuyệt đối
 * (luật 50), và Edge lẫn Node chạy ra cùng một kết quả trên cùng một bộ số.
 *
 * KHÔNG gia hạn khi:
 *  · không có token — chưa đăng nhập, hoặc vừa đăng xuất (cookie đã bị xoá);
 *  · token đã hết hạn — gia hạn một token chết là hồi sinh nó, tức là bỏ hẳn hạn phiên;
 *  · chưa qua nửa đời — chưa cần, và ký lại ở mọi lượt gọi là phí;
 *  · đã kịch trần tuyệt đối — mốc mới không xa hơn mốc cũ nên không có gì để gia hạn.
 */
export function decideRenewal(claims: SessionClaims | null, nowSec: number): RenewalDecision {
  if (!claims) return { renew: false, reason: "NO_TOKEN" };
  /*
    HẾT HẠN LÀ HẾT HẠN. Đây là vế quan trọng nhất của cả tệp: thiếu nó thì "gia hạn trượt" biến
    thành "phiên không bao giờ chết", và toàn bộ hạn đăng nhập của ERP thành trang trí.
  */
  if (nowSec >= claims.expiresAtSec) return { renew: false, reason: "EXPIRED" };

  const doiToken = claims.expiresAtSec - claims.issuedAtSec;
  const nguaDoi = claims.issuedAtSec + Math.floor(doiToken * SESSION_RENEW_AFTER_FRACTION);
  if (nowSec < nguaDoi) return { renew: false, reason: "TOO_EARLY" };

  const tranTuyetDoi = claims.loginAtSec + SESSION_ABSOLUTE_DAYS * NGAY;
  // Mốc mới = "còn thêm một kỳ nghỉ nữa", NHƯNG không bao giờ vượt trần sống.
  const mocMoi = Math.min(nowSec + SESSION_IDLE_DAYS * NGAY, tranTuyetDoi);
  if (mocMoi <= claims.expiresAtSec) return { renew: false, reason: "AT_ABSOLUTE_CAP" };

  return { renew: true, expiresAtSec: mocMoi, loginAtSec: claims.loginAtSec };
}

/**
 * Đọc luật phiên ra khỏi payload JWT đã XÁC MINH CHỮ KÝ.
 *
 * Nơi gọi phải `jwtVerify` trước — hàm này không kiểm chữ ký, nó chỉ bóc số. Trả `null` khi thiếu
 * mốc: một token không nói nó cấp lúc nào và hết hạn lúc nào thì không có gì để gia hạn, và ĐOÁN
 * hộ một trong hai mốc là tự tạo ra một phiên không ai kiểm được.
 *
 * `lgn` thiếu ⇒ lấy `iat`. Token phát hành TRƯỚC bản này không có claim đó, và với chúng thì `iat`
 * ĐÚNG là mốc đăng nhập: hồi ấy chưa có lần gia hạn nào để đẩy `iat` đi. Không cần migration, và
 * không tài khoản nào bị đá ra vì một lần triển khai.
 */
export function claimsFrom(payload: Record<string, unknown> | null | undefined): SessionClaims | null {
  if (!payload) return null;
  const so = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const iat = so(payload.iat);
  const exp = so(payload.exp);
  if (iat === null || exp === null) return null;
  return { issuedAtSec: iat, expiresAtSec: exp, loginAtSec: so(payload[SESSION_LOGIN_CLAIM]) ?? iat };
}

/**
 * Cookie phiên có được đánh dấu `secure` không — MỘT luật, hai nơi gọi.
 *
 * Node (`lib/auth/session.ts`) truyền `env.appUrl`; Edge (`middleware.ts`) truyền
 * `process.env.APP_URL` vì nó không import được `lib/env`. Phép tính thì chỉ có ở đây — hai bên
 * tự tính lấy là cách để một hôm nào đó cookie đăng nhập có cờ `secure` còn cookie gia hạn thì
 * không, và không ai để ý cho tới khi nó bị nghe lén.
 *
 * `requestProtocol` là LƯỚI AN TOÀN, chỉ thêm chứ không bớt: đang thật sự chạy trên https thì
 * đánh dấu `secure`, bất kể biến môi trường có mặt hay không. Sau một tấm proxy kết thúc TLS thì
 * giá trị này có thể là `http:` — lúc đó luật cũ vẫn quyết định, nên không có đường nào hạ cấp
 * một cookie đang đúng.
 */
export function sessionCookieSecure(nodeEnv: string | undefined, appUrl: string | undefined, requestProtocol?: string | null): boolean {
  if (requestProtocol === "https:") return true;
  return nodeEnv === "production" && (appUrl ?? "").startsWith("https");
}

/** Số giây còn lại để đặt `Max-Age`. Không bao giờ âm: `Max-Age` âm là lệnh XOÁ cookie. */
export function cookieMaxAgeSec(expiresAtSec: number, nowSec: number): number {
  return Math.max(0, expiresAtSec - nowSec);
}
