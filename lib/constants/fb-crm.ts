/**
 * ═══════════ FACEBOOK FRIEND CRM — HẰNG SỐ + LUẬT THUẦN (lát 1 · docs/verticals/facebook-friend-crm.md) ═══════════
 *
 * Tệp này KHÔNG đọc / ghi CSDL, KHÔNG gọi mạng ⇒ client component dùng được, và bài kiểm gọi thẳng được.
 *
 * GIỚI HẠN KHÔNG THƯƠNG LƯỢNG (AGENTS §5 + chủ shop):
 *  · ERP KHÔNG tự kết bạn, KHÔNG tự nhắn tin từ nick Facebook cá nhân, KHÔNG quét (scrape) Facebook, KHÔNG dùng tài khoản
 *    Facebook cá nhân. Mọi thao tác ở đây chỉ GHI LẠI việc một NGƯỜI đã làm bằng tay.
 *  · PSID (`sales_chat_conversations.thread_id`, `customers.fb_id`) là mã THEO PAGE — không bao giờ dựng `facebook.com/<PSID>`
 *    (lib/sales-chatbot/avatar-profile.ts `FACEBOOK_ID_SOURCES`). Link trang cá nhân chỉ có khi NGƯỜI dán vào.
 *  · Khách «không liên hệ» thì không đồng ý / mời / hẹn chăm sóc / tạo nhiệm vụ được — chỉ gỡ cờ (có người bấm) mới mở lại.
 */

/** Cờ tổ chức: `settings["fbCrm.enabled"] = {"on": true}`. Mặc định TẮT — tắt thì trang báo «chưa bật» và không có lối vào. */
export const FB_CRM_SETTING_KEY = "fbCrm.enabled";

/** Đọc cờ: CHỈ `{ on: true }` mới là bật (luật «cờ settings phải là object»; chuỗi trần / mảng / thiếu ⇒ tắt). */
export function fbCrmEnabledOf(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { on?: unknown }).on === true);
}

/**
 * NGUỒN của link Facebook — danh sách ĐÓNG (CHECK ở CSDL):
 *  · `CUSTOMER_PROVIDED` — khách tự gửi link trang của họ (trong hội thoại / khi gọi điện);
 *  · `STAFF_VERIFIED_FROM_PANCAKE` — nhân viên mở hội thoại trên Pancake, bấm avatar khách, tự xác nhận đúng người rồi dán link;
 *  · `NONE` — chưa có link. KHÔNG có nguồn «máy suy ra»: link KHÔNG BAO GIỜ được dựng từ PSID.
 */
export const FB_URL_SOURCES = ["CUSTOMER_PROVIDED", "STAFF_VERIFIED_FROM_PANCAKE", "NONE"] as const;
export type FbUrlSource = (typeof FB_URL_SOURCES)[number];
export const FB_URL_SET_SOURCES = ["CUSTOMER_PROVIDED", "STAFF_VERIFIED_FROM_PANCAKE"] as const satisfies readonly FbUrlSource[];
export const FB_URL_SOURCE_LABEL: Record<FbUrlSource, string> = {
  CUSTOMER_PROVIDED: "Khách tự gửi",
  STAFF_VERIFIED_FROM_PANCAKE: "NV xác nhận từ Pancake",
  NONE: "Chưa có link",
};

/** Trạng thái kết bạn với nick chăm sóc của shop — do NGƯỜI ghi, không máy nào đổi. */
export const FB_CONNECTION_STATUSES = ["NOT_ASKED", "CONSENTED", "INVITE_SENT", "FRIENDS", "DECLINED"] as const;
export type FbConnectionStatus = (typeof FB_CONNECTION_STATUSES)[number];
export const FB_CONNECTION_STATUS_LABEL: Record<FbConnectionStatus, string> = {
  NOT_ASKED: "Chưa hỏi",
  CONSENTED: "Khách đồng ý",
  INVITE_SENT: "Đã gửi lời mời",
  FRIENDS: "Đã kết bạn",
  DECLINED: "Khách từ chối",
};
export const FB_CONNECTION_STATUS_TONE: Record<FbConnectionStatus, string> = {
  NOT_ASKED: "bg-muted text-muted-foreground",
  CONSENTED: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  INVITE_SENT: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  FRIENDS: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  DECLINED: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

export const FB_EVENT_KINDS = ["URL_SET", "URL_CLEARED", "STATUS_CHANGED", "OWNER_CHANGED", "NEXT_CARE_SET", "DNC_SET", "DNC_CLEARED", "CONSENT_RECORDED"] as const;
export type FbEventKind = (typeof FB_EVENT_KINDS)[number];
export const FB_EVENT_KIND_LABEL: Record<FbEventKind, string> = {
  URL_SET: "Lưu link Facebook",
  URL_CLEARED: "Xoá link Facebook",
  STATUS_CHANGED: "Đổi trạng thái kết bạn",
  OWNER_CHANGED: "Đổi NV phụ trách",
  NEXT_CARE_SET: "Đặt ngày chăm sóc",
  DNC_SET: "Không liên hệ",
  DNC_CLEARED: "Gỡ không liên hệ",
  CONSENT_RECORDED: "Khách đồng ý kết nối",
};

/** Nhãn tương quan — in NGUYÊN câu này cạnh con số «đã kết bạn rồi mua» ở mọi màn hình (bài kiểm khoá chữ). */
export const FB_CRM_CORRELATION_LABEL = "Tương quan, KHÔNG phải doanh thu do CRM mang lại";

/** «Mua nhiều lần» = từ bấy nhiêu đơn GIAO THÀNH CÔNG (ORDER_OUTCOME) trở lên — không đếm đơn đã đặt / đơn hoàn. */
export const REPEAT_BUYER_MIN_DELIVERED = 2;

/** Bộ lọc của trang. `all` = mọi khách từng nhắn fanpage HOẶC có đơn. */
export const FB_CRM_VIEWS = ["all", "messaged", "bought", "not_bought", "quoted", "repeat", "lapsed", "consented", "friends", "not_friends", "dnc"] as const;
export type FbCrmView = (typeof FB_CRM_VIEWS)[number];
export const FB_CRM_VIEW_LABEL: Record<FbCrmView, string> = {
  all: "Tất cả",
  messaged: "Từng nhắn fanpage",
  bought: "Đã mua",
  not_bought: "Chưa mua",
  quoted: "Hỏi giá chưa đặt",
  repeat: "Mua nhiều lần",
  lapsed: "Lâu chưa quay lại",
  consented: "Đã đồng ý, chờ kết bạn",
  friends: "Đã kết bạn",
  not_friends: "Chưa kết bạn",
  dnc: "Không liên hệ",
};
export function fbCrmViewOf(v: string | undefined | null): FbCrmView {
  return v && (FB_CRM_VIEWS as readonly string[]).includes(v) ? (v as FbCrmView) : "all";
}

/** Khoá sắp xếp — trùng `id` cột của bảng (AGENTS §2). */
export const FB_CRM_SORTABLE = ["lastInteractionAt", "deliveredCount", "realRevenue", "nextCareOn", "name"] as const;

// ─────────────────────────── LINK FACEBOOK ───────────────────────────

export type FbUrlRejectReason = "EMPTY" | "NOT_URL" | "NOT_HTTPS" | "NOT_FACEBOOK" | "NOT_PROFILE" | "PSID_LIKE" | "PAGE_SCOPED_ID";
export const FB_URL_REJECT_LABEL: Record<FbUrlRejectReason, string> = {
  EMPTY: "Chưa dán link.",
  NOT_URL: "Không phải một đường link.",
  NOT_HTTPS: "Link phải bắt đầu bằng https://",
  NOT_FACEBOOK: "Chỉ nhận link facebook.com / www.facebook.com / m.facebook.com — không nhận link Pancake, Messenger, m.me, fb.com.",
  NOT_PROFILE: "Đây không phải trang cá nhân (link page / nhóm / bài viết / hộp thư). Dán link trang cá nhân của khách.",
  PSID_LIKE: "Dãy số trần không phải tên trang cá nhân — mã theo page (PSID) không mở được trang của khách.",
  PAGE_SCOPED_ID: "Mã trong link là mã THEO PAGE (PSID) của chính khách này — mở ra trang lỗi hoặc sai người.",
};

const FB_PROFILE_HOSTS = new Set(["facebook.com", "www.facebook.com", "m.facebook.com"]);
/** Đoạn đầu đường dẫn KHÔNG phải trang cá nhân (page, nhóm, bài, hộp thư, chia sẻ…). */
const FB_RESERVED_PATHS = new Set([
  "pages", "pg", "groups", "events", "messages", "messenger", "t", "dialog", "sharer", "sharer.php", "share", "share.php", "login", "login.php",
  "plugins", "permalink.php", "story.php", "photo", "photo.php", "photos", "watch", "reel", "reels", "ads", "business", "help", "l.php",
  "marketplace", "gaming", "hashtag", "search", "settings", "privacy", "policies", "home.php", "notifications", "friends", "people",
  "public", "media", "video.php", "videos", "posts", "stories", "live", "fundraisers", "legal", "terms", "about", "profile", "home",
  "bookmarks", "saved", "groups.php", "page", "events.php", "watch.php", "pancake",
]);

/**
 * Chuẩn hoá + kiểm link trang Facebook cá nhân. Chỉ nhận `https://(www.|m.)facebook.com/<username>` hoặc
 * `https://(www.|m.)facebook.com/profile.php?id=<số>`; lưu dạng chuẩn `https://www.facebook.com/…` (bỏ tham số theo dõi,
 * `#`, dấu `/` cuối; username về chữ thường vì Facebook không phân biệt hoa thường). `pageScopedIds` = mọi mã THEO PAGE ERP biết
 * về khách (PSID, `customers.fb_id`) — link trỏ vào chính mã đó bị loại. HÀM THUẦN.
 */
export function normalizeFacebookProfileUrl(raw: string | null | undefined, pageScopedIds: readonly (string | null | undefined)[] = []): { ok: true; url: string } | { ok: false; reason: FbUrlRejectReason } {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "EMPTY" };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: "NOT_URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: u.protocol === "http:" ? "NOT_HTTPS" : "NOT_URL" };
  if (!FB_PROFILE_HOSTS.has(u.hostname.toLowerCase()) || u.username || u.password || u.port) return { ok: false, reason: "NOT_FACEBOOK" };
  const scoped = new Set(pageScopedIds.map((x) => (x ?? "").trim()).filter(Boolean));
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length === 1 && segs[0].toLowerCase() === "profile.php") {
    const id = (u.searchParams.get("id") ?? "").trim();
    if (!/^\d{5,20}$/.test(id)) return { ok: false, reason: "NOT_PROFILE" };
    if (scoped.has(id)) return { ok: false, reason: "PAGE_SCOPED_ID" };
    return { ok: true, url: `https://www.facebook.com/profile.php?id=${id}` };
  }
  if (segs.length !== 1) return { ok: false, reason: "NOT_PROFILE" };
  const name = segs[0];
  if (scoped.has(name)) return { ok: false, reason: "PAGE_SCOPED_ID" };
  if (/^\d+$/.test(name)) return { ok: false, reason: "PSID_LIKE" };
  const lower = name.toLowerCase();
  if (FB_RESERVED_PATHS.has(lower) || lower.endsWith(".php")) return { ok: false, reason: "NOT_PROFILE" };
  if (!/^[A-Za-z0-9.]{5,50}$/.test(name) || !/[A-Za-z]/.test(name)) return { ok: false, reason: "NOT_PROFILE" };
  return { ok: true, url: `https://www.facebook.com/${lower}` };
}

// ─────────────────────────── LUẬT CHUYỂN TRẠNG THÁI ───────────────────────────

/** Trạng thái hiện tại của MỘT khách (dòng chưa có ⇒ `FB_CONNECTION_DEFAULT`). */
export type FbConnectionState = {
  fbProfileUrl: string | null;
  fbUrlSource: FbUrlSource;
  connectionStatus: FbConnectionStatus;
  careOwnerUserId: string | null;
  nextCareOn: string | null;
  doNotContact: boolean;
  doNotContactReason: string | null;
};

export const FB_CONNECTION_DEFAULT: FbConnectionState = {
  fbProfileUrl: null,
  fbUrlSource: "NONE",
  connectionStatus: "NOT_ASKED",
  careOwnerUserId: null,
  nextCareOn: null,
  doNotContact: false,
  doNotContactReason: null,
};

export type FbStatusTarget = Exclude<FbConnectionStatus, "NOT_ASKED">;

/** Một thao tác của người — đã qua zod ở service. `url` ở đây là link ĐÃ CHUẨN HOÁ. */
export type FbCrmOp =
  | { op: "SET_URL"; url: string; source: (typeof FB_URL_SET_SOURCES)[number] }
  | { op: "CLEAR_URL" }
  | { op: "SET_STATUS"; to: FbStatusTarget; note?: string }
  | { op: "SET_DNC"; reason: string }
  | { op: "CLEAR_DNC"; note?: string }
  | { op: "SET_OWNER"; userId: string | null }
  | { op: "SET_NEXT_CARE"; on: string | null };

export type FbPlannedEvent = { kind: FbEventKind; fromValue: string | null; toValue: string | null; note: string };
export type FbCrmPlan = { kind: "NOOP" } | { kind: "ERROR"; error: string } | { kind: "CHANGE"; next: FbConnectionState; events: FbPlannedEvent[] };

/**
 * Bước kết bạn đi TỚI được từ đâu:
 *  · «đồng ý» chỉ từ «chưa hỏi» / «từ chối» (khách đổi ý) — không lùi từ bước sau;
 *  · «đã gửi lời mời» CHỈ sau khi khách đồng ý — mời người chưa đồng ý là đúng thứ chủ shop cấm;
 *  · «đã kết bạn» ghi một SỰ THẬT (khách có thể tự kết bạn với nick shop) ⇒ từ mọi bước;
 *  · «từ chối» từ mọi bước.
 */
const STATUS_FROM: Record<FbStatusTarget, readonly FbConnectionStatus[]> = {
  CONSENTED: ["NOT_ASKED", "DECLINED"],
  INVITE_SENT: ["CONSENTED"],
  FRIENDS: ["NOT_ASKED", "CONSENTED", "INVITE_SENT", "DECLINED"],
  DECLINED: ["NOT_ASKED", "CONSENTED", "INVITE_SENT", "FRIENDS"],
};

/** Bước nào bị cờ «không liên hệ» chặn — mọi bước còn tiếp cận khách. */
const DNC_BLOCKED: ReadonlySet<FbStatusTarget> = new Set(["CONSENTED", "INVITE_SENT", "FRIENDS"]);

export const FB_DNC_BLOCK_MESSAGE = "Khách đang ở danh sách KHÔNG LIÊN HỆ — gỡ cờ trước (cần lý do của khách).";

/**
 * Lên kế hoạch cho MỘT thao tác: không đổi gì ⇒ `NOOP` (không ghi dòng, không ghi nhật ký — luật 61); vi phạm luật ⇒ `ERROR`;
 * còn lại ⇒ trạng thái mới + các dòng nhật ký. `today` = ngày VN `YYYY-MM-DD`. HÀM THUẦN.
 */
export function planFbCrmOp(cur: FbConnectionState, op: FbCrmOp, today: string): FbCrmPlan {
  const ev = (kind: FbEventKind, fromValue: string | null, toValue: string | null, note = ""): FbPlannedEvent => ({ kind, fromValue, toValue, note });
  switch (op.op) {
    case "SET_URL": {
      if (cur.fbProfileUrl === op.url && cur.fbUrlSource === op.source) return { kind: "NOOP" };
      return { kind: "CHANGE", next: { ...cur, fbProfileUrl: op.url, fbUrlSource: op.source }, events: [ev("URL_SET", cur.fbProfileUrl, op.url, FB_URL_SOURCE_LABEL[op.source])] };
    }
    case "CLEAR_URL": {
      if (cur.fbProfileUrl === null) return { kind: "NOOP" };
      return { kind: "CHANGE", next: { ...cur, fbProfileUrl: null, fbUrlSource: "NONE" }, events: [ev("URL_CLEARED", cur.fbProfileUrl, null)] };
    }
    case "SET_STATUS": {
      if (cur.connectionStatus === op.to) return { kind: "NOOP" };
      if (cur.doNotContact && DNC_BLOCKED.has(op.to)) return { kind: "ERROR", error: FB_DNC_BLOCK_MESSAGE };
      if (!STATUS_FROM[op.to].includes(cur.connectionStatus)) {
        return {
          kind: "ERROR",
          error: op.to === "INVITE_SENT" ? "Chỉ đánh dấu «đã gửi lời mời» SAU KHI khách đồng ý kết nối." : `Không chuyển được từ «${FB_CONNECTION_STATUS_LABEL[cur.connectionStatus]}» sang «${FB_CONNECTION_STATUS_LABEL[op.to]}».`,
        };
      }
      const note = (op.note ?? "").trim();
      return { kind: "CHANGE", next: { ...cur, connectionStatus: op.to }, events: [ev(op.to === "CONSENTED" ? "CONSENT_RECORDED" : "STATUS_CHANGED", cur.connectionStatus, op.to, note)] };
    }
    case "SET_DNC": {
      const reason = op.reason.trim();
      if (!reason) return { kind: "ERROR", error: "Ghi lý do không liên hệ (vd: khách yêu cầu không nhắn)." };
      if (cur.doNotContact) return { kind: "NOOP" };
      const events = [ev("DNC_SET", null, "true", reason)];
      // Không liên hệ ⇒ hẹn chăm sóc không còn ý nghĩa: xoá luôn, và nhật ký nói rõ nó bị xoá vì sao.
      if (cur.nextCareOn) events.push(ev("NEXT_CARE_SET", cur.nextCareOn, null, "xoá vì khách không liên hệ"));
      return { kind: "CHANGE", next: { ...cur, doNotContact: true, doNotContactReason: reason, nextCareOn: null }, events };
    }
    case "CLEAR_DNC": {
      if (!cur.doNotContact) return { kind: "NOOP" };
      return { kind: "CHANGE", next: { ...cur, doNotContact: false, doNotContactReason: null }, events: [ev("DNC_CLEARED", "true", "false", (op.note ?? "").trim())] };
    }
    case "SET_OWNER": {
      if (cur.careOwnerUserId === op.userId) return { kind: "NOOP" };
      return { kind: "CHANGE", next: { ...cur, careOwnerUserId: op.userId }, events: [ev("OWNER_CHANGED", cur.careOwnerUserId, op.userId)] };
    }
    case "SET_NEXT_CARE": {
      if (cur.nextCareOn === op.on) return { kind: "NOOP" };
      if (op.on !== null) {
        if (cur.doNotContact) return { kind: "ERROR", error: FB_DNC_BLOCK_MESSAGE };
        if (op.on < today) return { kind: "ERROR", error: "Ngày chăm sóc tiếp không được ở quá khứ." };
      }
      return { kind: "CHANGE", next: { ...cur, nextCareOn: op.on }, events: [ev("NEXT_CARE_SET", cur.nextCareOn, op.on)] };
    }
  }
}

/** Tạo nhiệm vụ CSKH được không — `null` = được. HÀM THUẦN. */
export function careTaskBlockedReason(cur: FbConnectionState): string | null {
  return cur.doNotContact ? FB_DNC_BLOCK_MESSAGE : null;
}

/**
 * CSDL của tổ chức CHƯA áp 0262 (đang phục vụ bằng lược đồ cũ — `DEGRADED_MIGRATION`, lib/constants/migration-serve-compat.ts):
 * SQLSTATE 42P01 «bảng chưa tồn tại». drizzle bọc lỗi pg trong `cause`. HÀM THUẦN.
 */
export function isUndefinedTableError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "42P01") return true;
  }
  return false;
}

export const FB_CRM_SCHEMA_MISSING = "CSDL của tổ chức chưa áp migration 0262 (Facebook CRM) — chờ lượt cập nhật lược đồ xong rồi thử lại. Chưa ghi gì.";

/** Nhãn của nhiệm vụ CSKH sinh từ trang này — dùng để chống trùng (một việc mở / khách / ngày). */
export const FB_CRM_TASK_TAG = "fb-crm";
