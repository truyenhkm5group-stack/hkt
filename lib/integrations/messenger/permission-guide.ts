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

// ─────────────────────────── Câu cho KHÁCH (màn «Kênh kết nối») ───────────────────────────
//
// DISCOVERY_GUIDE / WEBHOOK_GUIDE ở trên viết cho người biết App Dashboard (tên quyền, «webhook», «token»). Chủ shop không
// làm gì được với những chữ đó — nên màn của khách đọc bản dưới đây: lời thường + MỘT việc phải làm + AI làm. Lỗi nằm ở phía
// nền tảng (quyền của app, App Review) thì nói thẳng là KHÔNG phải lỗi của Page, không bắt khách đi sửa chỗ họ không vào được.
// Chi tiết kỹ thuật chỉ hiện cho người vận hành nền tảng (lib/channels/overview-shared.ts quét chuỗi cấm).

/** Ai làm việc của câu: chủ shop tự làm được, hay phải nhờ đội hỗ trợ nền tảng. */
export type CustomerIssueWho = "SHOP" | "SUPPORT";
export type CustomerIssue = { title: string; action: string; who: CustomerIssueWho };

/** Tên thường của từng quyền bắt buộc — để câu khách nói «quyền nhắn tin», không nói `pages_messaging`. */
export const PERMISSION_PLAIN_LABEL: Record<RequiredPermission, string> = {
  pages_show_list: "xem danh sách Page",
  pages_messaging: "nhắn tin",
  pages_manage_metadata: "nhận tin nhắn mới",
  pages_read_engagement: "đọc bình luận",
};

const SUPPORT_SIDE: CustomerIssue = {
  title: "Facebook chưa mở quyền nhắn tin cho ứng dụng của nền tảng",
  action: "Đây không phải lỗi ở Page của bạn — liên hệ đội hỗ trợ để được mở. Trong lúc chờ, Page vẫn nhận tin qua Pancake nếu bạn đang dùng.",
  who: "SUPPORT",
};

export const CUSTOMER_DISCOVERY_TEXT: Record<DiscoveryReason, CustomerIssue> = {
  TOKEN_EXPIRED: { title: "Lần đăng nhập Facebook vừa rồi không còn hiệu lực", action: "Bấm «Kết nối Facebook» lại và đăng nhập từ đầu.", who: "SHOP" },
  PERMISSION_DECLINED: { title: "Bạn chưa cấp đủ quyền cho Page", action: "Bấm «Kết nối lại», giữ BẬT mọi quyền Facebook hỏi và tick đủ các Page cần dùng.", who: "SHOP" },
  PERMISSION_NOT_IN_APP: SUPPORT_SIDE,
  PERMISSION_NEEDS_APP_REVIEW: SUPPORT_SIDE,
  PERMISSION_NOT_GRANTED: SUPPORT_SIDE,
  NO_PAGES: { title: "Tài khoản Facebook này chưa quản lý Page nào", action: "Đăng nhập bằng tài khoản quản trị Page (hoặc nhờ quản trị Page thêm bạn với quyền Tin nhắn), rồi bấm «Kết nối lại».", who: "SHOP" },
  NO_PAGE_TOKEN: { title: "Bạn chưa chọn Page nào ở bước «Chọn trang» của Facebook", action: "Bấm «Kết nối lại» và tick đủ các Page cần dùng.", who: "SHOP" },
  NO_MESSAGING_TASK: { title: "Tài khoản của bạn chưa có quyền nhắn tin trên Page", action: "Nhờ quản trị Page cấp quyền «Tin nhắn» (hoặc Toàn quyền) cho tài khoản này, rồi bấm «Kết nối lại».", who: "SHOP" },
};

export const CUSTOMER_WEBHOOK_TEXT: Record<Exclude<WebhookState, "OK">, CustomerIssue> = {
  NOT_SUBSCRIBED: { title: "Page chưa gửi tin nhắn mới về ERP", action: "Bấm «Kết nối lại» và chọn lại Page này.", who: "SHOP" },
  MISSING_FIELDS: { title: "Page mới gửi về một phần (thiếu tin nhắn hoặc bình luận)", action: "Bấm «Kết nối lại» và chọn lại Page này.", who: "SHOP" },
  TOKEN_EXPIRED: { title: "Facebook đã ngắt quyền của ERP với Page này", action: "Bấm «Kết nối lại» và đăng nhập bằng tài khoản quản trị Page.", who: "SHOP" },
  UNKNOWN: { title: "Chưa kiểm tra được Page", action: "Bấm «Kiểm tra lại» sau ít phút.", who: "SHOP" },
};

/**
 * Câu khách của MỘT lý do nối không được, kèm phần CỤ THỂ đọc được từ chẩn đoán đã lưu: quyền nào thiếu (tên thường),
 * Page nào thiếu quyền nhắn tin. Tên quyền kỹ thuật lạ (không thuộc bộ bắt buộc) bị bỏ — không in ra màn khách. HÀM THUẦN.
 */
export function customerDiscoveryIssue(reason: DiscoveryReason, facts: { missing?: readonly string[]; pageNames?: readonly string[] } = {}): CustomerIssue {
  const base = CUSTOMER_DISCOVERY_TEXT[reason];
  if (reason === "PERMISSION_DECLINED") {
    const labels = (facts.missing ?? []).filter((p): p is RequiredPermission => p in PERMISSION_PLAIN_LABEL).map((p) => PERMISSION_PLAIN_LABEL[p]);
    return labels.length ? { ...base, title: `Bạn chưa cấp quyền ${labels.join(", ")} cho Page` } : base;
  }
  if (reason === "NO_MESSAGING_TASK") {
    const names = (facts.pageNames ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 3);
    return names.length ? { ...base, title: `Tài khoản của bạn chưa có quyền nhắn tin trên Page ${names.map((n) => `«${n}»`).join(", ")}` } : base;
  }
  return base;
}

// ─────────────────────────── Configuration ID (Facebook Login for Business) ───────────────────────────
//
// App kiểu Doanh nghiệp cấp quyền theo CẤU HÌNH trên Meta, không theo `scope` (graph.ts `messengerConnectUrl`). Ba chỗ hỏng có
// ba người sửa khác nhau, nên ba chẩn đoán tách rời: (1) không khai Configuration ID ⇒ đang xin bằng danh sách quyền; (2) Meta
// từ chối cấu hình (không thuộc app / không hợp lệ) ⇒ việc của chủ nền tảng ở Meta; (3) cấu hình cấp THIẾU quyền bắt buộc ⇒
// thêm quyền vào Configuration; cấp THỪA chỉ là cảnh báo. Mã Configuration ID KHÔNG ghi cứng ở đâu — luôn đọc biến môi trường
// rồi truyền vào đây. Khách không bao giờ thấy câu gốc của Meta.

export type LoginConfigMode = { mode: "CONFIG"; configId: string } | { mode: "SCOPE" };

export function loginConfigMode(configId: string | null | undefined): LoginConfigMode {
  const id = (configId ?? "").trim();
  return id ? { mode: "CONFIG", configId: id } : { mode: "SCOPE" };
}

/** Câu NGƯỜI VẬN HÀNH: hộp thoại đang xin quyền bằng cách nào. */
export function loginModeText(m: LoginConfigMode): string {
  return m.mode === "CONFIG" ? `Đang xin quyền bằng Configuration ID ${m.configId} (Facebook Login for Business) — bộ quyền do cấu hình trên Meta quyết.` : "Đang xin quyền bằng danh sách quyền (không có Configuration ID) — app kiểu Doanh nghiệp có thể bỏ qua danh sách này.";
}

/** Câu Meta nhắc tới cấu hình đăng nhập (config_id không thuộc app / không hợp lệ / không tìm thấy). */
const CONFIG_ERROR_RE = /\bconfig(uration)?(_id|\s+id)?\b/i;

export type MetaConnectError = { kind: "CONFIG_REJECTED" | "OTHER"; customer: CustomerIssue; operator: string };

const CONNECT_INCOMPLETE: CustomerIssue = { title: "Kết nối Facebook chưa hoàn tất", action: "Lỗi nằm ở phía nền tảng, không phải ở Page của bạn — liên hệ đội hỗ trợ; khi được báo đã sửa, bấm «Kết nối lại».", who: "SUPPORT" };
const CONNECT_RETRY: CustomerIssue = { title: "Facebook chưa cho kết nối lúc này", action: "Thử «Kết nối lại» sau ít phút; nếu vẫn lỗi, liên hệ đội hỗ trợ.", who: "SHOP" };

/**
 * Lỗi Meta trả về ở lượt kết nối (câu `msg` của callback, hoặc `error_code` / `error_message` của hộp thoại) ⇒ câu khách (KHÔNG
 * mang chữ nào của Meta) + câu người vận hành (mang nguyên văn, Configuration ID, App ID). Không có lỗi ⇒ `null`. HÀM THUẦN.
 */
export function classifyMetaConnectError(input: { message?: string | null; errorCode?: string | null; errorReason?: string | null; errorMessage?: string | null }, ctx: { configId?: string | null; appId?: string | null }): MetaConnectError | null {
  const raw = [input.errorCode ? `mã ${input.errorCode}` : "", input.errorReason ? `lý do ${input.errorReason}` : "", input.errorMessage ?? "", input.message ?? ""].map((s) => s.trim()).filter(Boolean).join(" · ").slice(0, 400);
  if (!raw) return null;
  const mode = loginConfigMode(ctx.configId);
  const app = (ctx.appId ?? "").trim() || "(chưa khai)";
  const dialogCode = input.errorCode && /^\d{1,10}$/.test(input.errorCode) ? Number(input.errorCode) : null;
  if (dialogCode === DIALOG_REDIRECT_CODE) return { kind: "OTHER", customer: CONNECT_INCOMPLETE, operator: `URI chuyển hướng không thuộc app ${app} — khai đủ «URI chuyển hướng OAuth hợp lệ» (khối Messenger ở /platform). Meta: ${raw}` };
  // Hộp thoại chỉ trả MÃ (callback không chuyển câu chữ của Meta): đi bằng Configuration ID mà Meta báo «tham số không hợp lệ» ⇒
  // tham số khác thường duy nhất của lượt là `config_id`. Đi bằng danh sách quyền thì mã đó KHÔNG được quy cho cấu hình.
  if (CONFIG_ERROR_RE.test(raw) || (dialogCode !== null && DIALOG_CONFIG_CODES.has(dialogCode) && mode.mode === "CONFIG")) {
    const operator =
      mode.mode === "CONFIG"
        ? `Configuration ID ${mode.configId} không khớp app Messenger ${app} — kiểm ở Meta: Facebook Login for Business → Configurations. Meta: ${raw}`
        : `Meta nhắc tới cấu hình đăng nhập nhưng ERP đang xin quyền bằng danh sách quyền (không có Configuration ID) — app ${app} có thể đòi Configuration ID. Meta: ${raw}`;
    return { kind: "CONFIG_REJECTED", customer: CONNECT_INCOMPLETE, operator };
  }
  return { kind: "OTHER", customer: CONNECT_RETRY, operator: `${loginModeText(mode)} Meta: ${raw}` };
}

/**
 * Mã lỗi HỘP THOẠI của Meta (tham số `error_code` khi quay về callback). 100 = tham số không hợp lệ; 191 = URI chuyển hướng không
 * thuộc app. Chưa đo trên Meta thật với một Configuration ID sai — mã khác rơi về OTHER (vẫn in đủ cho người vận hành).
 */
const DIALOG_CONFIG_CODES: ReadonlySet<number> = new Set([100]);
const DIALOG_REDIRECT_CODE = 191;

export type MetaDialogError = { kind: "CANCELLED" } | { kind: "ERROR"; code: string; reason: string | null };

/**
 * Hộp thoại Meta quay về callback với lỗi ⇒ chỉ giữ phần ĐÃ LỌC: `error_code` toàn chữ số (≤ 10), `error_reason` khớp
 * `^[a-z_]{1,40}$`. `error_message` / `error_description` KHÔNG BAO GIỜ đi tiếp (câu chữ tự do của bên ngoài vào URL rồi vào màn
 * hình). Người dùng tự huỷ (`user_denied`) hoặc không có mã ⇒ `CANCELLED` — đúng hành vi cũ `loi=huy`. Không lỗi ⇒ `null`. HÀM THUẦN.
 */
export function metaDialogError(q: { get(name: string): string | null }): MetaDialogError | null {
  if (!["error", "error_code", "error_reason"].some((k) => (q.get(k) ?? "") !== "")) return null;
  const rawCode = q.get("error_code") ?? "";
  const rawReason = q.get("error_reason") ?? "";
  const code = /^\d{1,10}$/.test(rawCode) ? rawCode : null;
  const reason = /^[a-z_]{1,40}$/.test(rawReason) ? rawReason : null;
  if (reason === "user_denied" || !code) return { kind: "CANCELLED" };
  return { kind: "ERROR", code, reason };
}

/** Tham số quay về trang Messenger cho một lỗi hộp thoại đã lọc. */
export function metaDialogErrorQuery(e: Extract<MetaDialogError, { kind: "ERROR" }>): string {
  return new URLSearchParams({ loi: "meta", ma: e.code, ...(e.reason ? { ly: e.reason } : {}) }).toString();
}

/** Quyền Messenger KHÔNG cần mà một Configuration hay cấp kèm — chỉ cảnh báo cho người vận hành. */
const EXCESS_RE = /^(instagram_|business_management$)/;

/**
 * Đi bằng Configuration ID mà quyền ĐƯỢC CẤP thiếu một quyền bắt buộc ⇒ lỗi ở cấu hình (người vận hành thêm vào Configuration);
 * khách thấy câu thường + nút kết nối lại (có khi chính họ bỏ chọn). Quyền thừa chỉ thành cảnh báo cho người vận hành. Đi bằng
 * danh sách quyền, hoặc không đọc được quyền đã cấp (`granted = null`) ⇒ không kết luận (mảng rỗng, `customer = null`). HÀM THUẦN.
 */
export function configPermissionAudit(granted: readonly string[] | null, mode: LoginConfigMode, required: readonly RequiredPermission[]): { missing: RequiredPermission[]; excess: string[]; operator: string[]; customer: CustomerIssue | null } {
  if (mode.mode !== "CONFIG" || granted === null) return { missing: [], excess: [], operator: [], customer: null };
  const missing = required.filter((p) => !granted.includes(p));
  const excess = granted.filter((p) => EXCESS_RE.test(p));
  const operator = [
    ...missing.map((p) => `Cấu hình Login for Business ${mode.configId} thiếu quyền ${p} — thêm vào Configuration.`),
    ...(excess.length ? [`Cấu hình Login for Business ${mode.configId} cấp thừa ${excess.join(", ")} — Messenger không cần, nên bỏ khỏi Configuration (chỉ cảnh báo).`] : []),
  ];
  const labels = missing.map((p) => PERMISSION_PLAIN_LABEL[p]);
  const customer: CustomerIssue | null = missing.length ? { title: `Facebook chưa cấp quyền ${labels.join(", ")} cho Page`, action: "Bấm «Kết nối lại» và giữ BẬT mọi quyền Facebook hỏi; nếu vẫn thiếu, liên hệ đội hỗ trợ.", who: "SHOP" } : null;
  return { missing, excess, operator, customer };
}
