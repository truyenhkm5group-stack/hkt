import type { AppRoleCheck, DiscoveryDiagnostic, DiscoveryReason, PageWebhookCheck, RequiredPermission, WebhookState } from "@/lib/integrations/messenger/graph";

/**
 * ═══════════ HƯỚNG XỬ LÝ CHO TỪNG LÝ DO NỐI PAGE KHÔNG ĐƯỢC (docs/meta-app-review/) ═══════════
 *
 * Mỗi lý do (graph.ts `diagnosePageDiscovery` · `checkPageWebhook`) nói rõ AI phải làm và làm GÌ — vì «nối lại» không sửa được
 * lỗi nằm ở App Dashboard, còn «báo kỹ thuật» không sửa được việc chủ page bỏ chọn quyền. Không có câu chung chung «không quản lý
 * page nào» khi nguyên nhân là quyền.
 *
 * HÀM THUẦN, không import giá trị nào từ máy chủ (chỉ `import type`) — trang máy chủ và server action đều dùng được.
 */

export type GuideActor = "PAGE_OWNER" | "PLATFORM_OWNER";
export const GUIDE_ACTOR_LABEL: Record<GuideActor, string> = {
  PAGE_OWNER: "Chủ page / quản trị cửa hàng làm",
  PLATFORM_OWNER: "Chủ nền tảng làm trong Meta App Dashboard",
};

export type Guide = { title: string; actor: GuideActor; steps: string[] };

/** Vì sao từng quyền bắt buộc — cùng câu với tài liệu App Review (docs/meta-app-review/01-quyen-va-dieu-kien.md). */
export const PERMISSION_INFO: Record<RequiredPermission, string> = {
  pages_show_list: "Liệt kê các page tài khoản quản lý để chọn page nối với bot (/me/accounts).",
  pages_messaging: "Nhận và gửi tin Messenger thay page (Send API, trả lời riêng bình luận).",
  pages_manage_metadata: "Đăng ký webhook cho page (subscribed_apps) để tin khách nhắn tới được ERP.",
  pages_read_engagement: "Đọc nội dung bài viết khách bình luận dưới và hội thoại gần đây của page.",
};

export const DISCOVERY_GUIDE: Record<DiscoveryReason, Guide> = {
  TOKEN_EXPIRED: {
    title: "Phiên Facebook vừa cấp không còn hợp lệ",
    actor: "PAGE_OWNER",
    steps: ["Bấm «Kết nối Facebook Page» lại và đăng nhập Facebook từ đầu.", "Nếu vừa đổi mật khẩu Facebook hoặc gỡ app trong Cài đặt Facebook → Ứng dụng và trang web, đợi vài phút rồi kết nối lại."],
  },
  PERMISSION_DECLINED: {
    title: "Quyền bắt buộc đã bị bỏ chọn ở hộp thoại Facebook",
    actor: "PAGE_OWNER",
    steps: ["Bấm «Kết nối Facebook Page» lại — Facebook sẽ hỏi lại các quyền đã bỏ chọn.", "Ở bước «Chỉnh sửa quyền truy cập», giữ BẬT mọi quyền và tích đủ các page cần nối."],
  },
  PERMISSION_NOT_IN_APP: {
    title: "Quyền chưa được thêm vào app Meta (người bấm có vai trò trong app mà vẫn không được cấp)",
    actor: "PLATFORM_OWNER",
    steps: [
      "developers.facebook.com → My Apps → chọn app → Use cases.",
      "Thêm use case «Engage with customers on Messenger from Meta» (nếu chưa có) → Customize.",
      "Ở mục Permissions, bấm «Add» cho pages_show_list, pages_messaging, pages_manage_metadata, pages_read_engagement.",
      "Quay lại ERP, bấm «Kết nối Facebook Page» lại bằng chính tài khoản có vai trò trong app.",
    ],
  },
  PERMISSION_NEEDS_APP_REVIEW: {
    title: "App Meta cần Advanced Access (App Review) — tài khoản này không có vai trò trong app",
    actor: "PLATFORM_OWNER",
    steps: [
      "Trước khi duyệt: thêm tài khoản Facebook này vào app với vai trò Tester (App roles → Roles → Add People), người đó chấp nhận lời mời ở developers.facebook.com/requests, rồi kết nối lại.",
      "Lâu dài: nộp App Review xin Advanced Access cho 4 quyền bắt buộc (hướng dẫn ở docs/meta-app-review/README.md) — cần Business Verification và app ở chế độ Live.",
    ],
  },
  PERMISSION_NOT_GRANTED: {
    title: "Facebook không cấp quyền bắt buộc — chưa xác định được do app hay do App Review",
    actor: "PLATFORM_OWNER",
    steps: [
      "Kiểm tra trong App Dashboard: use case Messenger đã có 4 quyền bắt buộc chưa (Use cases → Customize → Permissions).",
      "Kiểm tra tài khoản bấm kết nối có vai trò Admin / Developer / Tester trong app không (App roles → Roles).",
      "Có vai trò mà vẫn thiếu ⇒ quyền chưa thêm vào app; không có vai trò ⇒ cần App Review (Advanced Access).",
    ],
  },
  NO_PAGES: {
    title: "Đủ quyền nhưng Facebook trả về 0 page",
    actor: "PAGE_OWNER",
    steps: ["Tài khoản này chưa có quyền với page nào: vào Meta Business Suite → Cài đặt → Trang (hoặc Page → Cài đặt → Quyền truy cập trang), thêm tài khoản với quyền Toàn quyền hoặc Nhắn tin.", "Kết nối lại và tích page ở bước «Chọn trang»."],
  },
  NO_PAGE_TOKEN: {
    title: "Facebook thấy page nhưng không giao quyền page cho app",
    actor: "PAGE_OWNER",
    steps: ["Bấm kết nối lại và ở bước «Chọn trang» tích ĐỦ các page cần nối.", "Page chỉ thuộc Business Portfolio: nhờ quản trị doanh nghiệp giao page trực tiếp cho tài khoản này (Business Settings → Người → Tài sản)."],
  },
  NO_MESSAGING_TASK: {
    title: "Tài khoản không có quyền quản trị / Nhắn tin trên page",
    actor: "PAGE_OWNER",
    steps: ["Nhờ quản trị page cấp cho tài khoản này quyền Toàn quyền hoặc «Tin nhắn» (Messages) trong Quyền truy cập trang.", "Hoặc đăng nhập bằng tài khoản quản trị page rồi kết nối lại."],
  },
};

export const WEBHOOK_GUIDE: Record<Exclude<WebhookState, "OK">, Guide> = {
  NOT_SUBSCRIBED: {
    title: "Page chưa đăng ký gửi tin về ERP",
    actor: "PAGE_OWNER",
    steps: ["Bấm «Thêm / nối lại page» và chọn lại page này — ERP đăng ký lại webhook khi nối.", "Nếu vẫn chưa được: kiểm tra Meta Business Suite → Cài đặt → Tích hợp doanh nghiệp, app không bị gỡ khỏi page."],
  },
  MISSING_FIELDS: {
    title: "Page đăng ký thiếu loại sự kiện",
    actor: "PAGE_OWNER",
    steps: ["Bấm «Thêm / nối lại page» và chọn lại page này — ERP đăng ký đủ trường khi nối.", "Nếu vẫn thiếu: chủ nền tảng kiểm tra quyền pages_manage_metadata / pages_read_engagement trong App Dashboard."],
  },
  TOKEN_EXPIRED: {
    title: "Token page hết hạn hoặc bị thu hồi",
    actor: "PAGE_OWNER",
    steps: ["Bấm «Thêm / nối lại page» bằng tài khoản quản trị page để cấp token mới.", "Token thường hỏng khi người cấp đổi mật khẩu Facebook, mất quyền trên page, hoặc gỡ app."],
  },
  UNKNOWN: {
    title: "Không đọc được trạng thái webhook — chưa kết luận",
    actor: "PLATFORM_OWNER",
    steps: ["Bấm «Kiểm tra lại» sau ít phút.", "Lặp lại nhiều lần: xem chi tiết lỗi Meta trả về bên dưới và kiểm tra quyền của app."],
  },
};

export const WEBHOOK_LABEL: Record<WebhookState, string> = {
  OK: "Webhook đã đăng ký đủ",
  NOT_SUBSCRIBED: "Webhook CHƯA đăng ký",
  MISSING_FIELDS: "Webhook thiếu trường",
  TOKEN_EXPIRED: "Token page hết hạn",
  UNKNOWN: "Chưa đọc được trạng thái webhook",
};

/** Một dòng trạng thái webhook trên màn hình — không token. */
export type WebhookRow = { pageId: string; name: string; state: WebhookState; label: string; tone: "ok" | "bad" | "muted"; detail: string | null; guide: Guide | null; tokenExpiresAt: string | null };

export function webhookRow(check: PageWebhookCheck, name: string): WebhookRow {
  const label = check.state === "MISSING_FIELDS" ? `${WEBHOOK_LABEL.MISSING_FIELDS}: ${check.missingFields.join(", ")}` : WEBHOOK_LABEL[check.state];
  return {
    pageId: check.pageId,
    name: name || check.pageId,
    state: check.state,
    label,
    tone: check.state === "OK" ? "ok" : check.state === "UNKNOWN" ? "muted" : "bad",
    detail: check.detail ? check.detail.slice(0, 300) : null,
    guide: check.state === "OK" ? null : WEBHOOK_GUIDE[check.state],
    tokenExpiresAt: check.token.expiresAt,
  };
}

export type PermissionStatus = "GRANTED" | "DECLINED" | "MISSING" | "UNKNOWN";
export const PERMISSION_STATUS_LABEL: Record<PermissionStatus, string> = { GRANTED: "đã cấp", DECLINED: "bị bỏ chọn", MISSING: "chưa được cấp", UNKNOWN: "không đọc được" };

/** Bảng quyền bắt buộc cho màn hình: từng quyền một trạng thái + vì sao cần. */
export function permissionTable(d: Pick<DiscoveryDiagnostic, "granted" | "declined">, required: readonly RequiredPermission[]): { permission: RequiredPermission; status: PermissionStatus; why: string }[] {
  return required.map((permission) => ({
    permission,
    status: d.granted === null ? "UNKNOWN" : d.granted.includes(permission) ? "GRANTED" : d.declined.includes(permission) ? "DECLINED" : "MISSING",
    why: PERMISSION_INFO[permission],
  }));
}

export function appRoleText(r: AppRoleCheck | null): string | null {
  if (!r) return null;
  if (r.state === "HAS_ROLE") return `Tài khoản bấm kết nối CÓ vai trò trong app (${r.role}).`;
  if (r.state === "NO_ROLE") return r.role ? `Tài khoản bấm kết nối chỉ có vai trò «${r.role}» — không đủ để dùng quyền trước App Review.` : "Tài khoản bấm kết nối KHÔNG có vai trò trong app.";
  return `Chưa xác định được vai trò trong app: ${r.why}`;
}
