/**
 * ═══════════ TRẦN TẦN SUẤT CỦA CHAT CÔNG KHAI (`/chat` · `/chat/embed`) ═══════════
 *
 * ─── VÌ SAO ───
 *
 * Trang chat công khai và ô chat NHÚNG website không cần đăng nhập, và mỗi tin khách gửi là một lượt AI. Trước bản này không có
 * trần tần suất nào ở cửa vào: trần sẵn có của engine (`SALES_CHATBOT_LIMITS.webMessagesPerVisitorPer10Min`, đếm trong CSDL)
 * khoá theo BĂM COOKIE — một script bỏ cookie sau mỗi lượt là thành "khách mới" và đi qua. Hậu quả:
 *  · đốt credit AI của shop: nguồn AI dùng chung có trần CỨNG theo tháng (`lib/ai-usage/quota.ts`), hết trần là bot IM với
 *    cả khách thật trên Messenger / Zalo của shop đó — một cuộc tấn công từ chối DOANH THU; nguồn khoá riêng thì shop trả tiền;
 *  · rác hội thoại trong CSDL của tổ chức (mỗi lượt mở = một hội thoại + một tin chào).
 *
 * ─── BA CHIỀU, MỖI CHIỀU MỘT XÔ, CHO HAI VIỆC ───
 *
 * Mỗi việc (`start` = mở hội thoại mới · `send` = gửi một tin) đi qua ba xô CÙNG LÚC, tất cả hoặc không (`lib/rate-limit.ts`):
 *  · KHÁCH — băm cookie `visitorKeyOf`: chặn một trình duyệt gửi dồn;
 *  · IP — địa chỉ do Caddy ghi (`clientIpFrom`, không bao giờ phần client tự khai), gom IPv6 theo /64: chặn một máy xoay cookie;
 *  · TỔ CHỨC — chặn bão từ nhiều nơi.
 * Mọi khoá đều mang mã tổ chức: hai shop không bao giờ chia chung một xô. IP không tin được (không có, nội bộ, cổng docker)
 * ⇒ bỏ chiều IP, vẫn áp trần khách + tổ chức — không chặn mù.
 *
 * ─── CON SỐ: ĐỦ RỘNG CHO KHÁCH THẬT, MỤC ĐÍCH LÀ CHẶN BÃO, KHÔNG PHẢI ĐIỀU TIẾT KINH DOANH ───
 *
 * Xô = `burst` lượt bắn liền, rồi đầy lại 1 lượt mỗi `refillMs` (nhịp bền vững). Người gửi đều đúng nhịp đó hoặc chậm hơn KHÔNG
 * BAO GIỜ chạm trần. Lý do từng số nằm cạnh số; `tests/public-chat-limits.test.ts` dựng lại các kiểu khách thật bên dưới và đòi
 * chúng đi qua (sửa số mà bài đỏ là đang chặn khách thật, không phải bài sai).
 *
 * Quan hệ với trần CSDL của engine: `webMessagesPerVisitorPer10Min` (20 tin / 10 phút / khách) vẫn chạy y như cũ — vượt nó thì
 * bot IM nhưng tin VẪN GHI (nhân viên đọc được), đúng quyết định của chủ shop 05/10/2026 cho khách thật nhắn nhiều. Trần ở đây
 * rộng hơn và đứng TRƯỚC: lượt bị chặn không gọi AI, không ghi tin, không tạo hội thoại, không chạy câu truy vấn nào của tổ chức.
 *
 * ─── VÌ SAO CÓ CÂU BÁO, DÙ CHỦ SHOP ĐÃ CHỐT "CHẠM TRẦN THÌ IM" ───
 *
 * "Im" của 05/10 áp cho lượt mà tin của khách ĐÃ được ghi — nhân viên vẫn thấy, không mất gì. Ở cổng này tin KHÔNG được ghi
 * (ghi là tạo đúng thứ rác cần chặn); im lặng ở đây là nuốt tin của khách mà khách không biết. Nên khách nhận MỘT câu kinh
 * doanh ở dòng báo của khung chat (không phải một tin của bot trong hội thoại), chữ khách vừa gõ được trả về ô nhập để gửi
 * lại, và không lộ chi tiết kỹ thuật nào. Ngưỡng đặt sao cho khách thật gần như không bao giờ thấy câu này.
 *
 * ─── GIỚI HẠN ĐÃ BIẾT ───
 *
 *  · Kho là `Map` trong tiến trình (`lib/sales-chatbot/public-chat-limits.ts`): mất khi container khởi động lại / deploy (kẻ
 *    dội được một mẻ `burst` mới sau mỗi lần deploy — chấp nhận được). Đúng cho MỘT tiến trình ứng dụng: production chạy ĐÚNG
 *    MỘT container `erp-app` (`docker-compose.prod.yml`, `container_name` cố định, `next start` một tiến trình). Chạy N bản
 *    thì mỗi bản có xô riêng ⇒ trần lỏng gấp N (không bao giờ chặt hơn) — khi ấy phải chuyển kho sang CSDL / Redis.
 *  · IP chỉ đúng khi Caddy là proxy DUY NHẤT trước ứng dụng (`deploy/Caddyfile`, cổng 3000 không mở ra ngoài). Đặt CDN / proxy
 *    khác trước Caddy mà không khai `trusted_proxies` thì IP thấy được là IP của máy CDN — mọi khách qua một máy CDN chung một
 *    xô IP. Cùng phụ thuộc với `lib/auth/login-throttle.ts`.
 *  · Bão PHÂN TÁN (nhiều IP, nhiều cookie) chỉ bị chặn bởi trần tổ chức — đó là bức tường cuối, không phải lời hứa về ngân
 *    sách AI; trần cứng theo tháng (`evaluateAiQuota`) và công tắc AI của nền tảng vẫn là hàng rào tiền.
 */

export type PublicChatAction = "start" | "send";

export const PUBLIC_CHAT_LIMITS = {
  /** MỞ hội thoại mới (`startPublicChat`): mỗi lượt = một dòng hội thoại + một tin chào trong CSDL của shop. */
  start: {
    /**
     * Một trình duyệt: mở trang `/chat`, mở ô chat trên từng trang của website shop, bấm «Hội thoại mới». 20 lượt liền rồi
     * 2 lượt / phút — khách mở ô chat trên 30 trang sản phẩm liền nhau, mỗi trang chừng 11 giây, vẫn lọt. (Script bỏ cookie
     * thì mỗi lượt là một "khách" mới — chiều này không chặn được nó; chiều IP và tổ chức mới chặn.)
     */
    visitor: { burst: 20, refillMs: 30_000 },
    /**
     * Một địa chỉ IP vào MỘT shop: nhà mạng di động Việt Nam dồn nhiều thuê bao sau một IPv4 (CGNAT), và quán / cửa hàng có
     * mã QR «chat để đặt» thì cả quán dùng chung Wi-Fi. 40 lượt liền (40 bàn mở chat cùng lúc) rồi 10 lượt / phút. Một máy
     * xoay cookie mở tối đa 600 hội thoại rác / giờ thay vì không giới hạn.
     */
    ip: { burst: 40, refillMs: 6_000 },
    /**
     * Cả shop: 120 lượt liền (một buổi livestream kêu khách vào chat) rồi 30 lượt / phút = 1.800 hội thoại mới / giờ — gấp
     * nhiều lần đỉnh của shop đông nhất hiện nay (vài trăm hội thoại web / giờ).
     */
    org: { burst: 120, refillMs: 2_000 },
  },
  /** GỬI một tin (`sendPublicChat`): mỗi lượt = một lượt AI (có thể nhiều vòng công cụ) + vài dòng tin trong CSDL. */
  send: {
    /**
     * Một khách: 20 tin liền («alo» · «shop ơi» · «còn hàng ko» gõ dồn) rồi 1 tin / 5 giây. Người phải đọc câu trả lời của bot
     * (vài giây mỗi lượt) không gửi đều nhanh hơn thế; gửi đúng 1 tin / 5 giây thì gửi bao nhiêu tin cũng không chạm trần.
     */
    visitor: { burst: 20, refillMs: 5_000 },
    /**
     * Một địa chỉ IP vào MỘT shop: 60 tin liền rồi 30 tin / phút ≈ 10 khách cùng một mạng (CGNAT / Wi-Fi quán) nhắn LIÊN TỤC,
     * mỗi người một tin / 20 giây. Một máy xoay cookie gọi được tối đa 30 lượt AI / phút vào một shop thay vì không giới hạn.
     */
    ip: { burst: 60, refillMs: 2_000 },
    /**
     * Cả shop: 240 tin liền rồi 2 tin / giây = 120 tin / phút ≈ 40 khách web nhắn CÙNG LÚC, mỗi người một tin / 20 giây. Bức
     * tường chặn bão từ nhiều nơi, không phải hạn mức kinh doanh — khách Messenger / Zalo không đi qua cổng này.
     */
    org: { burst: 240, refillMs: 500 },
  },
  /**
   * Trần số khoá trong bộ nhớ: một khoá ≈ 150 byte ⇒ ≤ 3 MB. Xô đã đầy lại bị dọn trước (không mất gì); quá trần thì dọn khoá ít
   * được chạm nhất — khoá đang bị dội không bao giờ bị dọn (`lib/rate-limit.ts::pruneBuckets`).
   */
  maxKeys: 20_000,
} as const;

/**
 * Câu khách thấy ở dòng báo của khung chat khi bị chặn — câu kinh doanh, không lộ chi tiết kỹ thuật (không IP, không mã lỗi,
 * không con số). Trần theo KHÁCH hay theo IP: nói với người đang gõ; trần theo TỔ CHỨC: nói về shop.
 */
export const PUBLIC_CHAT_LIMIT_MESSAGES = {
  tooFastSend: "Bạn gửi nhanh quá — chờ một chút rồi gửi tiếp.",
  tooFastStart: "Bạn mở chat nhanh quá — chờ một chút rồi thử lại.",
  shopBusy: "Shop đang nhận quá nhiều tin — thử lại sau ít phút.",
} as const;
